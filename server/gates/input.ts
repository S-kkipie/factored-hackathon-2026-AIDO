import type { Sql } from "../db/sql";
import type { RuleId } from "../rules";
import { type PiiKind, maskPii } from "./pii";

export interface InputLimits {
  maxChars: number;
  perMinute: number;
}

export type InputGateResult =
  | { ok: true; text: string; piiFound: PiiKind[] }
  | { ok: false; ruleId: Extract<RuleId, "IN_EMPTY" | "IN_SIZE" | "IN_RATE"> };

const DEFAULT_LIMITS: InputLimits = { maxChars: 1000, perMinute: 12 };

/** Gate 1: rejects empty, oversized and rate-limited messages; masks PII before anything else sees the text. */
export async function inputGate(
  ops: Sql,
  sessionId: string,
  raw: string,
  nowMs: number,
  limits: InputLimits = DEFAULT_LIMITS,
): Promise<InputGateResult> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, ruleId: "IN_EMPTY" };
  if (trimmed.length > limits.maxChars) return { ok: false, ruleId: "IN_SIZE" };

  await ops.run("delete from ops.rate_events where at_ms < $1", [nowMs - 60_000]);
  const recent =
    (
      await ops.one<{ n: number }>("select count(*)::int as n from ops.rate_events where session_id = $1 and at_ms > $2", [
        sessionId,
        nowMs - 60_000,
      ])
    )?.n ?? 0;
  if (recent >= limits.perMinute) return { ok: false, ruleId: "IN_RATE" };
  await ops.run("insert into ops.rate_events (session_id, at_ms) values ($1, $2)", [sessionId, nowMs]);

  const masked = maskPii(trimmed);
  return { ok: true, text: masked.text, piiFound: masked.found };
}
