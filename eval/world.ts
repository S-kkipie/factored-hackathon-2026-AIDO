import type { ServingDb, Transaction } from "../server/db/serving";
import type { Tools } from "../server/tools";
import { ToolError } from "../server/tools/runtime";
import type { Scenario } from "./scenario";

export interface World {
  set(s: Scenario | null): void;
  now(): number;
  advance(minutes: number): void;
  wrapServing(s: ServingDb): ServingDb;
  wrapTools(t: Tools): Tools;
  onDraftRejected(draft: string, ruleIds: string[]): void;
  rejections: { ruleIds: string[] }[];
}

/**
 * The per-scenario environment around the real server: which customer the "eval" persona logs in as, data faults
 * applied to every serving read (null fields, duplicated rows, an injected merchant name), tool failures, and the
 * auth clock. `set(null)` restores a clean world between scenarios.
 */
export function createWorld(): World {
  let current: Scenario | null = null;
  let offsetMs = 0;
  const rejections: { ruleIds: string[] }[] = [];

  const fault = () => current?.fault ?? null;
  const shape = (tx: Transaction): Transaction => {
    const f = fault();
    if (f?.kind === "null_fields") return { ...tx, merchant_name: null, amount_usd: null };
    if (f?.kind === "inject_merchant" && tx.transaction_id === f.transactionId) return { ...tx, merchant_name: f.text };
    return tx;
  };

  return {
    rejections,
    set(s) {
      current = s;
      offsetMs = 0;
      rejections.length = 0;
    },
    now: () => Date.now() + offsetMs,
    advance(minutes) {
      offsetMs += minutes * 60_000;
    },
    onDraftRejected(_draft, ruleIds) {
      rejections.push({ ruleIds: [...ruleIds] });
    },
    wrapServing(s) {
      return {
        ...s,
        demoUsers: () => (current ? [{ persona: "eval", customer_id: current.customerId }] : []),
        transactions: (customerId, filter) => {
          const rows = s.transactions(customerId, filter).map(shape);
          return fault()?.kind === "duplicate_rows" ? rows.flatMap((r) => [r, { ...r }]) : rows;
        },
        transaction: (customerId, id) => {
          const tx = s.transaction(customerId, id);
          return tx ? shape(tx) : null;
        },
      };
    },
    wrapTools(t) {
      const failing = (tool: string) => {
        const f = fault();
        return f?.kind === "tool_error" && f.tool === tool;
      };
      const fail = (tool: string): never => {
        throw new ToolError("TL_FAIL", tool, "injected failure", true);
      };
      return {
        ...t,
        getAccounts: (c) => (failing("getAccounts") ? fail("getAccounts") : t.getAccounts(c)),
        searchTransactions: (c, f) => (failing("searchTransactions") ? fail("searchTransactions") : t.searchTransactions(c, f)),
        createDispute: (i) => (failing("createDispute") ? fail("createDispute") : t.createDispute(i)),
      };
    },
  };
}
