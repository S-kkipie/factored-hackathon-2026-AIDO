import type { Customer, Transaction } from "../db/serving";
import type { Val } from "../provenance";
import type { RuleIdWithPrefix } from "../rules";
import { POLICY, type Policy } from "./config";

export type Intent =
  | "check_balance"
  | "list_transactions"
  | "explain_charge"
  | "dispute_charge"
  | "request_human"
  | "out_of_scope";

export type Action = "allow" | "confirm" | "clarify" | "escalate" | "deny";

export interface PolicyInput {
  intent: Intent;
  customer: Customer;
  /** Transactions the request is about (dispute or explanation targets); only `db`-sourced values are acceptable. */
  targets: Val<Transaction>[];
  disputedTransactionIds: string[];
  repeatComplainer: boolean;
  riskScore: number;
}

export type PolicyRuleId = RuleIdWithPrefix<"POL"> | RuleIdWithPrefix<"PROV">;

export interface Decision {
  action: Action;
  ruleIds: PolicyRuleId[];
  policyVersion: string;
}

const READ_INTENTS: readonly Intent[] = ["check_balance", "list_transactions", "explain_charge"];
const DAY_MS = 86_400_000;

const ageDays = (tx: Transaction, clock: string) =>
  (Date.parse(`${clock}T23:59:59Z`) - Date.parse(`${tx.transaction_date}Z`)) / DAY_MS;

/**
 * Pure policy engine: the only place that decides between acting, confirming and escalating.
 * Every check is written so that missing, NaN or unexpected values escalate (fail closed).
 *
 * Tiers: the gate tier (customer status, human request, session risk, provenance) is evaluated first and
 * short-circuits: when it escalates, dispute-level reasons are not evaluated or reported.
 */
export function decide(input: PolicyInput, p: Policy = POLICY): Decision {
  const result = (action: Action, ruleIds: Iterable<PolicyRuleId>): Decision => ({
    action,
    ruleIds: [...new Set(ruleIds)].sort(),
    policyVersion: p.version,
  });

  const gate: PolicyRuleId[] = [];
  if (input.customer.customer_status !== "Active") gate.push("POL_STATUS");
  if (input.intent === "request_human") gate.push("POL_HUMAN");
  if (!(input.riskScore < p.riskEscalate)) gate.push("POL_RISK");
  if (input.targets.some((t) => t.src !== "db")) gate.push("PROV_001");
  if (gate.length > 0) return result("escalate", gate);

  if (input.intent === "out_of_scope") return result("deny", ["POL_SCOPE"]);
  if (READ_INTENTS.includes(input.intent)) return result("allow", ["POL_READ"]);

  const targets = [...new Map(input.targets.map((t) => [t.v.transaction_id, t.v])).values()];
  if (targets.length === 0) return result("clarify", ["POL_DSP_NO_TARGET"]);
  const reasons = new Set<PolicyRuleId>();
  if (targets.length > p.maxTxPerDispute) reasons.add("POL_DSP_MANY");
  for (const t of targets) {
    if (t.amount_usd === null || !(t.amount_usd <= p.maxAutoUsd)) reasons.add("POL_DSP_AMOUNT");
    if (t.fraud_score === null || !(t.fraud_score < p.fraudScore)) reasons.add("POL_DSP_FRAUD");
    if (t.transaction_status !== "Approved") reasons.add("POL_DSP_STATUS");
    if (!p.disputableTypes.includes(t.transaction_type)) reasons.add("POL_DSP_TYPE");
    const age = ageDays(t, p.clock);
    if (!Number.isFinite(age) || age < 0 || age > p.maxDisputeAgeDays) reasons.add("POL_DSP_AGE");
    if (input.disputedTransactionIds.includes(t.transaction_id)) reasons.add("POL_DSP_DUP");
  }
  if (input.repeatComplainer) reasons.add("POL_REPEAT");
  return reasons.size > 0 ? result("escalate", reasons) : result("confirm", ["POL_DSP_OK"]);
}
