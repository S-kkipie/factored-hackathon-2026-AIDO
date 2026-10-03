import type { Sql } from "./db/sql";
import { sha256Hex } from "./hash";

export interface AuditInput {
  sessionId: string | null;
  kind: string;
  ruleId?: string;
  payload: unknown;
}

interface AuditRow {
  seq: number;
  at: string;
  session_id: string | null;
  kind: string;
  rule_id: string | null;
  payload: string;
  prev_hash: string;
  hash: string;
}

const link = (prev: string, at: string, sessionId: string | null, kind: string, ruleId: string | null, payload: string) =>
  sha256Hex([prev, at, sessionId ?? "", kind, ruleId ?? "", payload].join("|"));

/** Serializes chain appends across connections and instances (transaction-scoped advisory lock). */
const AUDIT_LOCK = 4_242_001;

/** Append-only, hash-chained record of gate decisions and actions. */
export function appendAudit(ops: Sql, input: AuditInput, now: Date = new Date()): Promise<{ seq: number; hash: string }> {
  return ops.tx(async (tx) => {
    await tx.one("select pg_advisory_xact_lock($1)", [AUDIT_LOCK]);
    const prev = (await tx.one<{ hash: string }>("select hash from ops.audit_events order by seq desc limit 1"))?.hash ?? "GENESIS";
    const at = now.toISOString();
    const payload = JSON.stringify(input.payload ?? null);
    const hash = link(prev, at, input.sessionId, input.kind, input.ruleId ?? null, payload);
    const row = await tx.one<{ seq: number }>(
      "insert into ops.audit_events (at, session_id, kind, rule_id, payload, prev_hash, hash) values ($1, $2, $3, $4, $5, $6, $7) returning seq",
      [at, input.sessionId, input.kind, input.ruleId ?? null, payload, prev, hash],
    );
    if (!row) throw new Error("audit insert returned no row");
    return { seq: row.seq, hash };
  });
}

export async function verifyAuditChain(ops: Sql): Promise<{ ok: true } | { ok: false; brokenAt: number }> {
  let prev = "GENESIS";
  for (const r of await ops.all<AuditRow>("select * from ops.audit_events order by seq")) {
    if (r.prev_hash !== prev || link(prev, r.at, r.session_id, r.kind, r.rule_id, r.payload) !== r.hash) {
      return { ok: false, brokenAt: r.seq };
    }
    prev = r.hash;
  }
  return { ok: true };
}
