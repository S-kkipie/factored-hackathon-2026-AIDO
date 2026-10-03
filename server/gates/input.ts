import type { Database } from "bun:sqlite";
import { type PiiKind, maskPii } from "./pii";

export interface InputLimits {
  maxChars: number;
  perMinute: number;
}

export type InputGateResult =
  | { ok: true; text: string; piiFound: PiiKind[] }
  | { ok: false; ruleId: "IN_EMPTY" | "IN_SIZE" | "IN_RATE" };

const DEFAULT_LIMITS: InputLimits = { maxChars: 1000, perMinute: 12 };

/** Gate 1: rejects empty, oversized and rate-limited messages; masks PII before anything else sees the text. */
export function inputGate(
  ops: Database,
  sessionId: string,
  raw: string,
  nowMs: number,
  limits: InputLimits = DEFAULT_LIMITS,
): InputGateResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, ruleId: "IN_EMPTY" };
  if (trimmed.length > limits.maxChars) return { ok: false, ruleId: "IN_SIZE" };

  ops.query("delete from rate_events where at_ms < ?").run(nowMs - 60_000);
  const recent =
    ops
      .query<{ n: number }, [string, number]>("select count(*) as n from rate_events where session_id = ? and at_ms > ?")
      .get(sessionId, nowMs - 60_000)?.n ?? 0;
  if (recent >= limits.perMinute) return { ok: false, ruleId: "IN_RATE" };
  ops.query("insert into rate_events (session_id, at_ms) values (?, ?)").run(sessionId, nowMs);

  const masked = maskPii(trimmed);
  return { ok: true, text: masked.text, piiFound: masked.found };
}
