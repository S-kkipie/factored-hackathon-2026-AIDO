import type { Sql } from "../db/sql";
import { canonicalJson, sha256Hex } from "../hash";
import type { RuleIdWithPrefix } from "../rules";

interface NonceContext {
  sessionId: string;
  interruptId: string;
  payload: unknown;
}

export type NonceRule = Extract<RuleIdWithPrefix<"TL">, `TL_NONCE_${string}`>;

/** Key order never changes the hash: payloads are serialized as canonical JSON. */
const hashPayload = (payload: unknown) => sha256Hex(canonicalJson(payload));

/** Issues a single-use nonce that only a UI confirmation can return; chat text can never confirm. */
export async function issueNonce(ops: Sql, ctx: NonceContext, nowMs: number, ttlMs = 10 * 60_000): Promise<string> {
  const nonce = crypto.randomUUID();
  await ops.run(
    "insert into ops.nonces (nonce, session_id, interrupt_id, payload_hash, expires_at) values ($1, $2, $3, $4, $5)",
    [nonce, ctx.sessionId, ctx.interruptId, hashPayload(ctx.payload), nowMs + ttlMs],
  );
  return nonce;
}

export async function consumeNonce(
  ops: Sql,
  ctx: NonceContext & { nonce: string },
  nowMs: number,
): Promise<{ ok: true } | { ok: false; ruleId: NonceRule }> {
  const row = await ops.one<{
    session_id: string;
    interrupt_id: string;
    payload_hash: string;
    expires_at: number;
    used_at: number | null;
  }>("select session_id, interrupt_id, payload_hash, expires_at, used_at from ops.nonces where nonce = $1", [ctx.nonce]);
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
  // Single use even across connections: only one UPDATE can flip used_at from null.
  const changed = await ops.run("update ops.nonces set used_at = $1 where nonce = $2 and used_at is null", [nowMs, ctx.nonce]);
  return changed === 1 ? { ok: true } : { ok: false, ruleId: "TL_NONCE_USED" };
}
