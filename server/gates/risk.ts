import type { Sql } from "../db/sql";

export const RISK_WEIGHTS = {
  injectionSignal: 1.5,
  abstain: 0.5,
  policyDeny: 1,
  provenanceViolation: 3,
} as const;

export type RiskReason = keyof typeof RISK_WEIGHTS;

/** Fails closed: an unknown session has no risk score to report. */
export async function getRisk(ops: Sql, sessionId: string): Promise<number> {
  const row = await ops.one<{ r: number }>("select risk_score as r from ops.sessions where session_id = $1", [sessionId]);
  if (!row) throw new Error(`RSK_SESSION: unknown session ${sessionId}`);
  return row.r;
}

/** Accumulates per-session risk; policy escalates when it crosses POLICY.riskEscalate. */
export async function addRisk(ops: Sql, sessionId: string, reason: RiskReason): Promise<number> {
  const row = await ops.one<{ r: number }>(
    "update ops.sessions set risk_score = risk_score + $1 where session_id = $2 returning risk_score as r",
    [RISK_WEIGHTS[reason], sessionId],
  );
  if (!row) throw new Error(`RSK_SESSION: unknown session ${sessionId}`);
  return row.r;
}
