import { type BaseEvent, EventType } from "@ag-ui/core";

export interface ChatLine {
  id: string;
  author: "user" | "assistant" | "agent" | "system";
  text: string;
}

/** A dispute confirmation waiting for the customer's click (spec 3.2-5); the nonce goes back in the resume entry. */
export interface PendingConfirm {
  interruptId: string;
  message: string;
  nonce: string;
  expiresAt: string | null;
}

export interface ChatState {
  lines: ChatLine[];
  running: boolean;
  /** Graph node currently running (STEP_STARTED), for the live status line. */
  step: string | null;
  route: { label: string; confidence: number } | null;
  decision: { action: string; ruleIds: string[] } | null;
  outcome: string | null;
  ruleIds: string[];
  /** Last dispute case created in this chat; kept across turns. */
  caseId: string | null;
  handoffId: string | null;
  pending: PendingConfirm | null;
  error: string | null;
  /** True from a handoff until the server reports the session active again. */
  handedOff: boolean;
  lastAgentMessageId: number;
}

export const initialChat: ChatState = {
  lines: [],
  running: false,
  step: null,
  route: null,
  decision: null,
  outcome: null,
  ruleIds: [],
  caseId: null,
  handoffId: null,
  pending: null,
  error: null,
  handedOff: false,
  lastAgentMessageId: 0,
};

export type ChatAction =
  | { type: "user"; id: string; text: string }
  | { type: "event"; event: BaseEvent }
  | { type: "agent_messages"; messages: { id: number; text: string }[] }
  | { type: "session_status"; status: string; notice: string }
  | { type: "failed"; message: string }
  | { type: "resume_sent" };

const HANDOFF_OUTCOMES = new Set(["handoff", "handed_off"]);

type DeltaOp = { op: string; path: string; value?: unknown };

function applyDelta(s: ChatState, ops: DeltaOp[]): ChatState {
  let next = s;
  for (const op of ops) {
    if (op.op !== "add" && op.op !== "replace") continue;
    switch (op.path) {
      case "/route":
        next = { ...next, route: op.value as ChatState["route"] };
        break;
      case "/decision":
        next = { ...next, decision: op.value as ChatState["decision"] };
        break;
      case "/outcome": {
        const outcome = String(op.value);
        next = { ...next, outcome, handedOff: next.handedOff || HANDOFF_OUTCOMES.has(outcome) };
        break;
      }
      case "/ruleIds":
        next = { ...next, ruleIds: Array.isArray(op.value) ? op.value.map(String) : [] };
        break;
      case "/caseId":
        next = { ...next, caseId: String(op.value) };
        break;
      case "/handoffId":
        next = { ...next, handoffId: String(op.value) };
        break;
    }
  }
  return next;
}

function pendingFrom(outcome: unknown): PendingConfirm | null {
  const o = outcome as { type?: string; interrupts?: { id?: unknown; message?: unknown; expiresAt?: unknown; metadata?: { nonce?: unknown } }[] };
  const first = o?.type === "interrupt" ? o.interrupts?.[0] : undefined;
  if (!first || typeof first.id !== "string" || typeof first.metadata?.nonce !== "string") return null;
  return {
    interruptId: first.id,
    message: typeof first.message === "string" ? first.message : "",
    nonce: first.metadata.nonce,
    expiresAt: typeof first.expiresAt === "string" ? first.expiresAt : null,
  };
}

function onEvent(s: ChatState, e: BaseEvent): ChatState {
  const x = e as BaseEvent & Record<string, unknown>;
  switch (e.type) {
    case EventType.RUN_STARTED:
      return { ...s, running: true, step: null, route: null, decision: null, outcome: null, ruleIds: [], error: null, pending: null };
    case EventType.STEP_STARTED:
      return { ...s, step: String(x.stepName) };
    case EventType.STATE_DELTA:
      return applyDelta(s, (x.delta as DeltaOp[]) ?? []);
    case EventType.TEXT_MESSAGE_START:
      return { ...s, lines: [...s.lines, { id: String(x.messageId), author: "assistant", text: "" }] };
    case EventType.TEXT_MESSAGE_CONTENT:
      return {
        ...s,
        lines: s.lines.map((l) => (l.id === String(x.messageId) ? { ...l, text: l.text + String(x.delta ?? "") } : l)),
      };
    case EventType.RUN_FINISHED:
      return { ...s, running: false, step: null, pending: pendingFrom(x.outcome) };
    case EventType.RUN_ERROR:
      return { ...s, running: false, step: null, error: String(x.message ?? "error") };
    default:
      return s;
  }
}

/** Pure reducer from AG-UI events (and a few UI actions) to chat state. All text stays plain text. */
export function chatReducer(s: ChatState, a: ChatAction): ChatState {
  switch (a.type) {
    case "user":
      return { ...s, lines: [...s.lines, { id: a.id, author: "user", text: a.text }], error: null };
    case "event":
      return onEvent(s, a.event);
    case "agent_messages": {
      const fresh = a.messages.filter((m) => m.id > s.lastAgentMessageId).sort((x, y) => x.id - y.id);
      if (fresh.length === 0) return s;
      return {
        ...s,
        lines: [...s.lines, ...fresh.map((m) => ({ id: `agent-${m.id}`, author: "agent" as const, text: m.text }))],
        lastAgentMessageId: fresh.at(-1)!.id,
      };
    }
    case "session_status":
      if (a.status === "active" && s.handedOff) {
        return { ...s, handedOff: false, lines: [...s.lines, { id: `sys-${s.lines.length}`, author: "system", text: a.notice }] };
      }
      return s;
    case "failed":
      return { ...s, running: false, step: null, error: a.message };
    case "resume_sent":
      return { ...s, pending: null };
  }
}
