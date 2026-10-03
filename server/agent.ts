import type { Database } from "bun:sqlite";
import { appendAudit } from "./audit";
import type { Auth } from "./auth";
import { maskPii } from "./gates/pii";
import { type HandoffCard, sanitizeNote } from "./tools";

export interface QueueItem {
  handoffId: string;
  sessionId: string;
  status: "queued" | "taken";
  createdAt: string;
  takenBy: string | null;
  ruleIds: string[];
  /** Structured card. Its strings are display text only: the console renders them as text, never as HTML. */
  card: HandoffCard;
}

export interface ChatMessage {
  id: number;
  author: "customer" | "agent";
  text: string;
  at: string;
}

interface HandoffRow {
  handoff_id: string;
  session_id: string;
  status: "queued" | "taken";
  created_at: string;
  taken_by: string | null;
  rule_ids: string;
  card: string;
}

export function listQueue(ops: Database): QueueItem[] {
  return ops
    .query<HandoffRow, []>(
      "select handoff_id, session_id, status, created_at, taken_by, rule_ids, card from handoffs where status in ('queued', 'taken') order by created_at",
    )
    .all()
    .map((r) => ({
      handoffId: r.handoff_id,
      sessionId: r.session_id,
      status: r.status,
      createdAt: r.created_at,
      takenBy: r.taken_by,
      ruleIds: JSON.parse(r.rule_ids) as string[],
      card: JSON.parse(r.card) as HandoffCard,
    }));
}

const openHandoff = (ops: Database, sessionId: string) =>
  ops
    .query<{ handoff_id: string; status: string }, [string]>(
      "select handoff_id, status from handoffs where session_id = ? and status in ('queued', 'taken') order by created_at desc limit 1",
    )
    .get(sessionId);

/** Claims the session's open handoff for this agent. False when there is none or another agent holds it. */
export function takeSession(ops: Database, sessionId: string, agentSessionId: string): boolean {
  const h = openHandoff(ops, sessionId);
  if (!h) return false;
  const changed = ops
    .query("update handoffs set status = 'taken', taken_by = ? where handoff_id = ? and (taken_by is null or taken_by = ?)")
    .run(agentSessionId, h.handoff_id, agentSessionId).changes;
  if (changed === 1) appendAudit(ops, { sessionId, kind: "agent_take", payload: { handoffId: h.handoff_id } });
  return changed === 1;
}

const heldBy = (ops: Database, sessionId: string, agentSessionId: string) =>
  ops
    .query<{ n: number }, [string, string]>(
      "select count(*) as n from handoffs where session_id = ? and status = 'taken' and taken_by = ?",
    )
    .get(sessionId, agentSessionId)?.n === 1;

/** A human reply to the customer. Only the agent holding the handoff may reply. */
export function agentReply(ops: Database, sessionId: string, agentSessionId: string, text: string, now = new Date()): boolean {
  if (!heldBy(ops, sessionId, agentSessionId)) return false;
  const clean = sanitizeNote(text);
  if (clean.length === 0) return false;
  ops.query("insert into messages (session_id, author, text, at) values (?, 'agent', ?, ?)").run(sessionId, clean, now.toISOString());
  appendAudit(ops, { sessionId, kind: "agent_reply", payload: { chars: clean.length } });
  return true;
}

/**
 * Closes the handoff and gives the conversation back to the assistant — but only reactivates the session when
 * it is still `handed_off`. If the customer logged out (or otherwise left `handed_off`) while the agent held the
 * case, resuming must not revive a revoked token into `active`.
 */
export function resolveSession(ops: Database, auth: Pick<Auth, "setStatus">, sessionId: string, agentSessionId: string, now = new Date()): boolean {
  if (!heldBy(ops, sessionId, agentSessionId)) return false;
  ops
    .query("update handoffs set status = 'resolved', resolved_at = ? where session_id = ? and status = 'taken'")
    .run(now.toISOString(), sessionId);
  const status = ops.query<{ status: string }, [string]>("select status from sessions where session_id = ?").get(sessionId)?.status;
  if (status === "handed_off") auth.setStatus(sessionId, "active");
  appendAudit(ops, { sessionId, kind: "agent_resolve", payload: {} });
  return true;
}

export function sessionMessages(ops: Database, sessionId: string, afterId = 0): ChatMessage[] {
  return ops
    .query<ChatMessage, [string, number]>(
      "select id, author, text, at from messages where session_id = ? and id > ? order by id limit 200",
    )
    .all(sessionId, afterId)
    .map((m) => ({ ...m, text: m.author === "customer" ? maskPii(m.text).text : m.text }));
}
