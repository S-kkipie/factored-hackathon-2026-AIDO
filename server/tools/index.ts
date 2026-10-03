import type { Database } from "bun:sqlite";
import type { Complaint, Product, ServingDb, Transaction, TxFilter } from "../db/serving";
import { sha256Hex } from "../hash";
import { type Val, trusted, val } from "../provenance";
import { ToolError } from "./runtime";

export type DisputeReason = "unrecognized" | "incorrect_amount" | "duplicate";

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

export interface HandoffCard {
  summary: string;
  verifiedFacts: { kind: string; id: string; detail: string }[];
  actionsTaken: string[];
  ruleIds: string[];
  openQuestions: string[];
  language: "es" | "pt";
  sentiment?: string;
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

export interface Tools {
  getAccounts(customerId: Val<string>): Val<Product[]>;
  searchTransactions(customerId: Val<string>, filter: TxFilter): Val<Transaction[]>;
  /** The transaction id may come from any source: the lookup is scoped to the session customer. */
  getTransaction(customerId: Val<string>, transactionId: Val<string>): Val<Transaction>;
  getDisputeHistory(customerId: Val<string>): Val<DisputeHistory>;
  createDispute(input: CreateDisputeInput): Val<Dispute>;
  getDispute(customerId: Val<string>, disputeId: string): Val<Dispute> | null;
  createHandoff(input: { sessionId: string; customerId: Val<string>; ruleIds: string[]; card: HandoffCard }): Val<{
    handoffId: string;
  }>;
}

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

const toDispute = (r: DisputeRow): Dispute => ({ ...r, transaction_ids: JSON.parse(r.transaction_ids) as string[] });

export function createTools(serving: ServingDb, ops: Database, now: () => Date = () => new Date()): Tools {
  const customer = (v: Val<string>) => trusted("customerId", v, ["jwt"]);
  const disputeById = (customerId: string, disputeId: string) =>
    ops
      .query<DisputeRow, [string, string]>("select * from disputes where customer_id = ? and dispute_id = ?")
      .get(customerId, disputeId);

  return {
    getAccounts: (customerId) => val(serving.products(customer(customerId)), "db"),
    searchTransactions: (customerId, filter) => val(serving.transactions(customer(customerId), filter), "db"),
    getTransaction(customerId, transactionId) {
      const tx = serving.transaction(customer(customerId), transactionId.v);
      if (!tx) throw new ToolError("TL_NOT_FOUND", "getTransaction", "no such transaction for this customer");
      return val(tx, "db");
    },
    getDisputeHistory(customerId) {
      const id = customer(customerId);
      const complaints = serving.complaints(id);
      const disputed = ops
        .query<{ transaction_ids: string }, [string]>("select transaction_ids from disputes where customer_id = ?")
        .all(id)
        .flatMap((r) => JSON.parse(r.transaction_ids) as string[]);
      return val(
        {
          complaints,
          disputedTransactionIds: [...new Set(disputed)].sort(),
          repeatComplainer: complaints.some((c) => c.is_repeat_complainer === 1),
        },
        "db",
      );
    },
    createDispute(input) {
      const customerId = customer(input.customerId);
      const txs = input.transactions.map((t) => trusted("transaction", t, ["db"]));
      for (const t of txs) {
        if (t.customer_id !== customerId) {
          throw new ToolError("TL_OWNER", "createDispute", "transaction does not belong to the session customer");
        }
      }
      const disputeId = `D-${sha256Hex(input.idempotencyKey).slice(0, 8).toUpperCase()}`;
      const note = input.customerNote ? sanitizeNote(input.customerNote.v) : null;
      ops
        .query(
          `insert into disputes (dispute_id, idempotency_key, session_id, customer_id, transaction_ids, reason,
             customer_note, note_untrusted, amount_usd, status, created_at)
           values (?, ?, ?, ?, ?, ?, ?, 1, ?, 'received', ?)
           on conflict (idempotency_key) do nothing`,
        )
        .run(
          disputeId,
          input.idempotencyKey,
          input.sessionId,
          customerId,
          JSON.stringify(txs.map((t) => t.transaction_id)),
          input.reason,
          note,
          txs.reduce((sum, t) => sum + (t.amount_usd ?? 0), 0),
          now().toISOString(),
        );
      const row = ops
        .query<DisputeRow, [string]>("select * from disputes where idempotency_key = ?")
        .get(input.idempotencyKey);
      if (!row) throw new ToolError("TL_FAIL", "createDispute", "dispute not persisted", true);
      return val(toDispute(row), "db");
    },
    getDispute(customerId, disputeId) {
      const row = disputeById(customer(customerId), disputeId);
      return row ? val(toDispute(row), "db") : null;
    },
    createHandoff(input) {
      const customerId = customer(input.customerId);
      const handoffId = `H-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      ops
        .query(
          "insert into handoffs (handoff_id, session_id, customer_id, rule_ids, card, created_at) values (?, ?, ?, ?, ?, ?)",
        )
        .run(
          handoffId,
          input.sessionId,
          customerId,
          JSON.stringify(input.ruleIds),
          JSON.stringify(input.card),
          now().toISOString(),
        );
      return val({ handoffId }, "db");
    },
  };
}
