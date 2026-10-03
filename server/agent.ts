import { appendAudit } from "./audit";
import type { Auth } from "./auth";
import type { Sql } from "./db/sql";
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

export async function listQueue(ops: Sql): Promise<QueueItem[]> {
  const rows = await ops.all<HandoffRow>(
    "select handoff_id, session_id, status, created_at, taken_by, rule_ids, card from ops.handoffs where status in ('queued', 'taken') order by created_at, handoff_id",
  );
  return rows.map((r) => ({
    handoffId: r.handoff_id,
    sessionId: r.session_id,
    status: r.status,
    createdAt: r.created_at,
    takenBy: r.taken_by,
    ruleIds: JSON.parse(r.rule_ids) as string[],
    card: JSON.parse(r.card) as HandoffCard,
  }));
}

const openHandoff = (ops: Sql, sessionId: string) =>
  ops.one<{ handoff_id: string; status: string }>(
    "select handoff_id, status from ops.handoffs where session_id = $1 and status in ('queued', 'taken') order by created_at desc limit 1",
    [sessionId],
  );

/** Claims the session's open handoff for this agent. False when there is none or another agent holds it. */
export async function takeSession(ops: Sql, sessionId: string, agentSessionId: string): Promise<boolean> {
  const h = await openHandoff(ops, sessionId);
  if (!h) return false;
  const changed = await ops.run(
    "update ops.handoffs set status = 'taken', taken_by = $1 where handoff_id = $2 and status in ('queued', 'taken') and (taken_by is null or taken_by = $1)",
    [agentSessionId, h.handoff_id],
  );
  if (changed === 1) await appendAudit(ops, { sessionId, kind: "agent_take", payload: { handoffId: h.handoff_id } });
  return changed === 1;
}

const heldBy = async (ops: Sql, sessionId: string, agentSessionId: string) =>
  (
    await ops.one<{ n: number }>(
      "select count(*)::int as n from ops.handoffs where session_id = $1 and status = 'taken' and taken_by = $2",
      [sessionId, agentSessionId],
    )
  )?.n === 1;

/** A human reply to the customer. Only the agent holding the handoff may reply. */
export async function agentReply(ops: Sql, sessionId: string, agentSessionId: string, text: string, now = new Date()): Promise<boolean> {
  if (!(await heldBy(ops, sessionId, agentSessionId))) return false;
  const clean = sanitizeNote(text);
  if (clean.length === 0) return false;
  await ops.run("insert into ops.messages (session_id, author, text, at) values ($1, 'agent', $2, $3)", [
    sessionId,
    clean,
    now.toISOString(),
  ]);
  await appendAudit(ops, { sessionId, kind: "agent_reply", payload: { chars: clean.length } });
  return true;
}

/**
 * Closes the handoff and gives the conversation back to the assistant — but only reactivates the session when
 * it is still `handed_off`. If the customer logged out (or otherwise left `handed_off`) while the agent held the
 * case, resuming must not revive a revoked token into `active`.
 */
export async function resolveSession(
  ops: Sql,
  auth: Pick<Auth, "setStatus">,
  sessionId: string,
  agentSessionId: string,
  now = new Date(),
): Promise<boolean> {
  if (!(await heldBy(ops, sessionId, agentSessionId))) return false;
  await ops.run(
    "update ops.handoffs set status = 'resolved', resolved_at = $1 where session_id = $2 and status = 'taken' and taken_by = $3",
    [now.toISOString(), sessionId, agentSessionId],
  );
  const status = (await ops.one<{ status: string }>("select status from ops.sessions where session_id = $1", [sessionId]))?.status;
  if (status === "handed_off") await auth.setStatus(sessionId, "active");
  await appendAudit(ops, { sessionId, kind: "agent_resolve", payload: {} });
  return true;
}

export async function sessionMessages(ops: Sql, sessionId: string, afterId = 0): Promise<ChatMessage[]> {
  const rows = await ops.all<ChatMessage>(
    "select id, author, text, at from ops.messages where session_id = $1 and id > $2 order by id limit 200",
    [sessionId, afterId],
  );
  return rows.map((m) => ({ ...m, text: m.author === "customer" ? maskPii(m.text).text : m.text }));
}
