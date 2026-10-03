import type { Database } from "bun:sqlite";
import { Value } from "@sinclair/typebox/value";
import type { Complaint, Product, ServingDb, Transaction, TxFilter } from "../db/serving";
import { canonicalJson, sha256Hex } from "../hash";
import { type Val, trusted, val } from "../provenance";
import { ToolError } from "./runtime";
import { type DisputeReason, DisputeReasonSchema, type HandoffCard, HandoffCardSchema, TxFilterSchema } from "./schemas";

export { DisputeReasonSchema, HandoffCardSchema, TxFilterSchema } from "./schemas";
export type { DisputeReason, HandoffCard } from "./schemas";

export interface Dispute {
  dispute_id: string;
  customer_id: string;
  transaction_ids: string[];
  reason: DisputeReason;
  amount_usd: number;
  status: "received";
  created_at: string;
  customer_note: string | null;
}

export interface DisputeHistory {
  complaints: Complaint[];
  disputedTransactionIds: string[];
  repeatComplainer: boolean;
}

export interface CreateDisputeInput {
  sessionId: string;
  customerId: Val<string>;
  transactions: Val<Transaction>[];
  reason: DisputeReason;
  customerNote: Val<string> | null;
  idempotencyKey: string;
}

export interface CreateHandoffInput {
  sessionId: string;
  customerId: Val<string>;
  ruleIds: string[];
  card: HandoffCard;
  idempotencyKey: string;
}

export interface Tools {
  getAccounts(customerId: Val<string>): Val<Product[]>;
  searchTransactions(customerId: Val<string>, filter: TxFilter): Val<Transaction[]>;
  /** The transaction id may come from any source: the lookup is scoped to the session customer. */
  getTransaction(customerId: Val<string>, transactionId: Val<string>): Val<Transaction>;
  getDisputeHistory(customerId: Val<string>): Val<DisputeHistory>;
  createDispute(input: CreateDisputeInput): Val<Dispute>;
  getDispute(customerId: Val<string>, disputeId: string): Val<Dispute> | null;
  createHandoff(input: CreateHandoffInput): Val<{ handoffId: string }>;
}

export const SEARCH_LIMIT = { min: 1, max: 50, default: 20 } as const;

/** Untrusted customer text stored for humans: no control chars, no markup characters, bounded length. */
export function sanitizeNote(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[<>`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

const DISPUTE_COLUMNS = "dispute_id, customer_id, transaction_ids, reason, amount_usd, status, created_at, customer_note";

interface DisputeRow {
  dispute_id: string;
  customer_id: string;
  transaction_ids: string;
  reason: DisputeReason;
  amount_usd: number;
  status: "received";
  created_at: string;
  customer_note: string | null;
}

const toDispute = (r: DisputeRow): Dispute => ({
  dispute_id: r.dispute_id,
  customer_id: r.customer_id,
  transaction_ids: JSON.parse(r.transaction_ids) as string[],
  reason: r.reason,
  amount_usd: r.amount_usd,
  status: r.status,
  created_at: r.created_at,
  customer_note: r.customer_note,
});

const shortId = (prefix: "D" | "H", key: string) => `${prefix}-${sha256Hex(key).slice(0, 12).toUpperCase()}`;

const clampLimit = (limit: number | undefined) =>
  limit === undefined ? SEARCH_LIMIT.default : Math.min(SEARCH_LIMIT.max, Math.max(SEARCH_LIMIT.min, Math.trunc(limit)));

export function createTools(serving: ServingDb, ops: Database, now: () => Date = () => new Date()): Tools {
  const customer = (v: Val<string>) => trusted("customerId", v, ["jwt"]);
  const disputeById = (customerId: string, disputeId: string) =>
    ops
      .query<DisputeRow, [string, string]>(`select ${DISPUTE_COLUMNS} from disputes where customer_id = ? and dispute_id = ?`)
      .get(customerId, disputeId);
  const disputeByKey = (customerId: string, key: string) =>
    ops
      .query<DisputeRow & { payload_hash: string | null }, [string, string]>(
        `select ${DISPUTE_COLUMNS}, payload_hash from disputes where idempotency_key = ? and customer_id = ?`,
      )
      .get(key, customerId);
  const disputedIds = (customerId: string) =>
    new Set(
      ops
        .query<{ transaction_ids: string }, [string]>("select transaction_ids from disputes where customer_id = ?")
        .all(customerId)
        .flatMap((r) => JSON.parse(r.transaction_ids) as string[]),
    );
  const mismatch = (tool: string) =>
    new ToolError("TL_IDEMPOTENCY_MISMATCH", tool, "idempotency key was already used for a different request");

  return {
    getAccounts: (customerId) => val(serving.products(customer(customerId)), "db"),
    searchTransactions(customerId, filter) {
      const id = customer(customerId);
      if (!Value.Check(TxFilterSchema, filter)) {
        throw new ToolError("TL_BAD_INPUT", "searchTransactions", "invalid transaction filter");
      }
      return val(serving.transactions(id, { ...filter, limit: clampLimit(filter.limit) }), "db");
    },
    getTransaction(customerId, transactionId) {
      const tx = serving.transaction(customer(customerId), transactionId.v);
      if (!tx) throw new ToolError("TL_NOT_FOUND", "getTransaction", "no such transaction for this customer");
      return val(tx, "db");
    },
    getDisputeHistory(customerId) {
      const id = customer(customerId);
      const complaints = serving.complaints(id);
      return val(
        {
          complaints,
          disputedTransactionIds: [...disputedIds(id)].sort(),
          repeatComplainer: complaints.some((c) => c.is_repeat_complainer === 1),
        },
        "db",
      );
    },
    createDispute(input) {
      const tool = "createDispute";
      const customerId = customer(input.customerId);
      if (!Value.Check(DisputeReasonSchema, input.reason)) throw new ToolError("TL_BAD_INPUT", tool, "invalid reason");
      const checked = input.transactions.map((t) => trusted("transaction", t, ["db"]));
      if (checked.length === 0) throw new ToolError("TL_EMPTY", tool, "a dispute needs at least one transaction");
      const txs = [...new Map(checked.map((t) => [t.transaction_id, t])).values()];
      const txIds = txs.map((t) => t.transaction_id).sort();
      const payloadHash = sha256Hex(canonicalJson({ customer: customerId, transactionIds: txIds, reason: input.reason }));

      const existing = disputeByKey(customerId, input.idempotencyKey);
      if (existing) {
        if (existing.payload_hash !== payloadHash) throw mismatch(tool);
        return val(toDispute(existing), "db");
      }

      // Defense in depth: the policy engine already checked these, the tool re-checks against the database.
      const alreadyDisputed = disputedIds(customerId);
      for (const t of txs) {
        const fresh = t.customer_id === customerId ? serving.transaction(customerId, t.transaction_id) : null;
        if (!fresh) throw new ToolError("TL_OWNER", tool, "transaction does not belong to the session customer");
        if (fresh.transaction_status !== "Approved") {
          throw new ToolError("TL_NOT_DISPUTABLE", tool, "only approved transactions can be disputed");
        }
        if (alreadyDisputed.has(fresh.transaction_id)) {
          throw new ToolError("TL_ALREADY_DISPUTED", tool, "transaction already has a dispute");
        }
      }

      const note = input.customerNote ? sanitizeNote(input.customerNote.v) : null;
      const inserted = ops
        .query(
          `insert into disputes (dispute_id, idempotency_key, session_id, customer_id, transaction_ids, reason,
             customer_note, note_untrusted, amount_usd, status, created_at, payload_hash)
           values (?, ?, ?, ?, ?, ?, ?, 1, ?, 'received', ?, ?)
           on conflict do nothing`,
        )
        .run(
          shortId("D", input.idempotencyKey),
          input.idempotencyKey,
          input.sessionId,
          customerId,
          JSON.stringify(txIds),
          input.reason,
          note,
          txs.reduce((sum, t) => sum + (t.amount_usd ?? 0), 0),
          now().toISOString(),
          payloadHash,
        ).changes;
      const row = disputeByKey(customerId, input.idempotencyKey);
      if (!row) {
        // The key (or derived id) belongs to another customer: never reveal or reuse their record.
        if (inserted === 0) throw mismatch(tool);
        throw new ToolError("TL_FAIL", tool, "dispute not persisted", true);
      }
      if (row.payload_hash !== payloadHash) throw mismatch(tool);
      return val(toDispute(row), "db");
    },
    getDispute(customerId, disputeId) {
      const row = disputeById(customer(customerId), disputeId);
      return row ? val(toDispute(row), "db") : null;
    },
    createHandoff(input) {
      const tool = "createHandoff";
      const customerId = customer(input.customerId);
      if (!Value.Check(HandoffCardSchema, input.card)) throw new ToolError("TL_BAD_INPUT", tool, "invalid handoff card");
      const payloadHash = sha256Hex(canonicalJson({ customer: customerId, ruleIds: input.ruleIds, card: input.card }));
      const byKey = () =>
        ops
          .query<{ handoff_id: string; payload_hash: string | null }, [string, string]>(
            "select handoff_id, payload_hash from handoffs where idempotency_key = ? and customer_id = ?",
          )
          .get(input.idempotencyKey, customerId);
      let row = byKey();
      if (!row) {
        ops
          .query(
            `insert into handoffs (handoff_id, idempotency_key, payload_hash, session_id, customer_id, rule_ids, card, created_at)
             values (?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing`,
          )
          .run(
            shortId("H", input.idempotencyKey),
            input.idempotencyKey,
            payloadHash,
            input.sessionId,
            customerId,
            JSON.stringify(input.ruleIds),
            JSON.stringify(input.card),
            now().toISOString(),
          );
        row = byKey();
        if (!row) throw mismatch(tool);
      }
      if (row.payload_hash !== payloadHash) throw mismatch(tool);
      return val({ handoffId: row.handoff_id }, "db");
    },
  };
}
