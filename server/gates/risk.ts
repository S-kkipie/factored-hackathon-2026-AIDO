import type { Database } from "bun:sqlite";

export const RISK_WEIGHTS = {
  injectionSignal: 1.5,
  abstain: 0.5,
  policyDeny: 1,
  provenanceViolation: 3,
} as const;

export type RiskReason = keyof typeof RISK_WEIGHTS;

export function getRisk(ops: Database, sessionId: string): number {
  return (
    ops.query<{ r: number }, [string]>("select risk_score as r from sessions where session_id = ?").get(sessionId)?.r ?? 0
  );
}

/** Accumulates per-session risk; policy escalates when it crosses POLICY.riskEscalate. */
export function addRisk(ops: Database, sessionId: string, reason: RiskReason): number {
  ops.query("update sessions set risk_score = risk_score + ? where session_id = ?").run(RISK_WEIGHTS[reason], sessionId);
  return getRisk(ops, sessionId);
}
