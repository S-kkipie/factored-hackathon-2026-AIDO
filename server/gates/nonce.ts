import type { Database } from "bun:sqlite";
import { sha256Hex } from "../hash";

interface NonceContext {
  sessionId: string;
  interruptId: string;
  payload: unknown;
}

export type NonceRule = "TL_NONCE_UNKNOWN" | "TL_NONCE_USED" | "TL_NONCE_EXPIRED" | "TL_NONCE_MISMATCH";

const hashPayload = (payload: unknown) => sha256Hex(JSON.stringify(payload));

/** Issues a single-use nonce that only a UI confirmation can return; chat text can never confirm. */
export function issueNonce(ops: Database, ctx: NonceContext, nowMs: number, ttlMs = 10 * 60_000): string {
  const nonce = crypto.randomUUID();
  ops
    .query("insert into nonces (nonce, session_id, interrupt_id, payload_hash, expires_at) values (?, ?, ?, ?, ?)")
    .run(nonce, ctx.sessionId, ctx.interruptId, hashPayload(ctx.payload), nowMs + ttlMs);
  return nonce;
}

export function consumeNonce(
  ops: Database,
  ctx: NonceContext & { nonce: string },
  nowMs: number,
): { ok: true } | { ok: false; ruleId: NonceRule } {
  const row = ops
    .query<
      { session_id: string; interrupt_id: string; payload_hash: string; expires_at: number; used_at: number | null },
      [string]
    >("select session_id, interrupt_id, payload_hash, expires_at, used_at from nonces where nonce = ?")
    .get(ctx.nonce);
  if (!row) return { ok: false, ruleId: "TL_NONCE_UNKNOWN" };
  if (row.used_at !== null) return { ok: false, ruleId: "TL_NONCE_USED" };
  if (nowMs > row.expires_at) return { ok: false, ruleId: "TL_NONCE_EXPIRED" };
  if (
    row.session_id !== ctx.sessionId ||
    row.interrupt_id !== ctx.interruptId ||
    row.payload_hash !== hashPayload(ctx.payload)
  ) {
    return { ok: false, ruleId: "TL_NONCE_MISMATCH" };
  }
  const changed = ops
    .query("update nonces set used_at = ? where nonce = ? and used_at is null")
    .run(nowMs, ctx.nonce).changes;
  return changed === 1 ? { ok: true } : { ok: false, ruleId: "TL_NONCE_USED" };
}
