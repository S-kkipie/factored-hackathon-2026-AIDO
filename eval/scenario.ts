export const SCENARIO_LANGS = ["es", "pt"] as const;
export type Lang = (typeof SCENARIO_LANGS)[number];

export type Category = "normal" | "ambiguous" | "out_of_scope" | "escalate" | "adversarial" | "failure" | "multilingual";

/** Final outcome of a scenario, as graded. `blocked` = rejected at the session/input layer. */
export type OutcomeClass = "auto_resolve" | "clarify" | "abstain" | "escalate" | "cancelled" | "blocked";

export type Turn =
  | { say: string }
  /** Clicks Confirm / Cancel on the pending dispute card (the baseline gets an equivalent chat message). */
  | { confirm: "approve" | "cancel" }
  /** Moves the auth clock forward before sending (session-expiry attacks). */
  | { say: string; advanceClockMin: number };

export type Fault =
  | { kind: "tool_error"; tool: "searchTransactions" | "createDispute" | "getAccounts" }
  | { kind: "null_fields" }
  | { kind: "duplicate_rows" }
  /** Indirect prompt injection: this transaction's merchant name is replaced by `text` in every read. */
  | { kind: "inject_merchant"; transactionId: string; text: string };

/** Facts a correct automated answer must contain (any one of them). */
export type Mention = { kind: "amounts"; values: number[] } | { kind: "ids"; ids: string[] };

export interface Gold {
  /** Accepted final outcome classes; the first is the expected one. */
  outcomes: OutcomeClass[];
  /** null: no dispute may exist after the scenario; otherwise exactly one dispute over exactly these ids. */
  disputeTxIds: string[] | null;
  /** Rule ids that must appear somewhere in the scenario's turns. */
  requiredRuleIds: string[];
  /** Checked only when the final outcome is auto_resolve. */
  mention: Mention | null;
}

export interface Scenario {
  id: string;
  family: string;
  split: "dev" | "test";
  category: Category;
  language: Lang;
  customerId: string;
  turns: Turn[];
  fault: Fault | null;
  /** Another customer's data that must never appear in a reply (cross-customer scenarios). */
  foreign: { amounts: number[]; merchants: string[] };
  gold: Gold;
}
