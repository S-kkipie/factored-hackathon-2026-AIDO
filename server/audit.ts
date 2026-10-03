import type { Database } from "bun:sqlite";
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

/** Append-only, hash-chained record of gate decisions and actions. */
export function appendAudit(ops: Database, input: AuditInput, now: Date = new Date()): { seq: number; hash: string } {
  const prev = ops.query<{ hash: string }, []>("select hash from audit_events order by seq desc limit 1").get()?.hash ?? "GENESIS";
  const at = now.toISOString();
  const payload = JSON.stringify(input.payload ?? null);
  const hash = link(prev, at, input.sessionId, input.kind, input.ruleId ?? null, payload);
  const row = ops
    .query<{ seq: number }, [string, string | null, string, string | null, string, string, string]>(
      "insert into audit_events (at, session_id, kind, rule_id, payload, prev_hash, hash) values (?, ?, ?, ?, ?, ?, ?) returning seq",
    )
    .get(at, input.sessionId, input.kind, input.ruleId ?? null, payload, prev, hash);
  if (!row) throw new Error("audit insert returned no row");
  return { seq: row.seq, hash };
}

export function verifyAuditChain(ops: Database): { ok: true } | { ok: false; brokenAt: number } {
  let prev = "GENESIS";
  for (const r of ops.query<AuditRow, []>("select * from audit_events order by seq").all()) {
    if (r.prev_hash !== prev || link(prev, r.at, r.session_id, r.kind, r.rule_id, r.payload) !== r.hash) {
      return { ok: false, brokenAt: r.seq };
    }
    prev = r.hash;
  }
  return { ok: true };
}
