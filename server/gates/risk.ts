import type { Database } from "bun:sqlite";

export const RISK_WEIGHTS = {
  injectionSignal: 1.5,
  abstain: 0.5,
  policyDeny: 1,
  provenanceViolation: 3,
} as const;

export type RiskReason = keyof typeof RISK_WEIGHTS;

/** Fails closed: an unknown session has no risk score to report. */
export function getRisk(ops: Database, sessionId: string): number {
  const row = ops.query<{ r: number }, [string]>("select risk_score as r from sessions where session_id = ?").get(sessionId);
  if (!row) throw new Error(`RSK_SESSION: unknown session ${sessionId}`);
  return row.r;
}

/** Accumulates per-session risk; policy escalates when it crosses POLICY.riskEscalate. */
export function addRisk(ops: Database, sessionId: string, reason: RiskReason): number {
  const changed = ops
    .query("update sessions set risk_score = risk_score + ? where session_id = ?")
    .run(RISK_WEIGHTS[reason], sessionId).changes;
  if (changed === 0) throw new Error(`RSK_SESSION: unknown session ${sessionId}`);
  return getRisk(ops, sessionId);
}
