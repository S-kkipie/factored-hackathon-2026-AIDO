/** Thin client for the AIDO server. Identity always travels as a Bearer JWT; the server never trusts client state. */

export type Language = "es" | "pt";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly ruleId: string | null,
  ) {
    super(`HTTP ${status}${ruleId ? ` (${ruleId})` : ""}`);
  }
}

async function request<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { ruleId?: string } | null;
    throw new ApiError(res.status, body?.ruleId ?? null);
  }
  return (await res.json()) as T;
}

export interface LoginResult {
  token: string;
  sessionId: string;
  language?: Language;
  expiresAt: number;
}

export const api = {
  demoUsers: () => request<{ persona: string }[]>("/api/demo-users"),
  login: (persona: string, pin: string, language: Language) =>
    request<LoginResult>("/api/auth/login", { method: "POST", body: JSON.stringify({ persona, pin, language }) }),
  agentLogin: (pin: string) => request<LoginResult>("/api/auth/agent", { method: "POST", body: JSON.stringify({ pin }) }),
  logout: (token: string) => request<{ ok: true }>("/api/auth/logout", { method: "POST" }, token),
  agentMessages: (token: string, after: number) => request<ChatMessage[]>(`/api/chat/messages?after=${after}`, {}, token),
  queue: (token: string) => request<QueueItem[]>("/api/agent/queue", {}, token),
  sessionMessages: (token: string, sessionId: string) =>
    request<ChatMessage[]>(`/api/agent/sessions/${encodeURIComponent(sessionId)}/messages`, {}, token),
  take: (token: string, sessionId: string) =>
    request<{ ok: boolean }>(`/api/agent/sessions/${encodeURIComponent(sessionId)}/take`, { method: "POST" }, token),
  reply: (token: string, sessionId: string, text: string) =>
    request<{ ok: boolean }>(`/api/agent/sessions/${encodeURIComponent(sessionId)}/reply`, { method: "POST", body: JSON.stringify({ text }) }, token),
  resolve: (token: string, sessionId: string) =>
    request<{ ok: boolean }>(`/api/agent/sessions/${encodeURIComponent(sessionId)}/resume`, { method: "POST" }, token),
  trace: (token: string, sessionId: string) => request<Span[]>(`/api/trace/${encodeURIComponent(sessionId)}`, {}, token),
  overview: (token: string) => request<CustomerOverview>("/api/me/overview", {}, token),
  cases: (token: string) => request<CustomerCase[]>("/api/me/cases", {}, token),
  metrics: (token: string, hours: number) => request<OpsMetrics>(`/api/ops/metrics?hours=${hours}`, {}, token),
};

export interface ChatMessage {
  id: number;
  author: "customer" | "agent";
  text: string;
  at: string;
}

export interface HandoffCard {
  summary: string;
  verifiedFacts: { kind: string; id: string; detail: string }[];
  actionsTaken: string[];
  ruleIds: string[];
  openQuestions: string[];
  language: Language;
}

export interface QueueItem {
  handoffId: string;
  sessionId: string;
  status: "queued" | "taken";
  createdAt: string;
  takenBy: string | null;
  ruleIds: string[];
  card: HandoffCard;
}

export interface Span {
  span_id: string;
  trace_id: string;
  session_id: string;
  parent_id: string | null;
  name: string;
  started_at: string;
  duration_ms: number;
  attributes: Record<string, string | number | boolean | null | string[]>;
}

// ── AG-UI over SSE ─────────────────────────────────────────────────────────────────────────────────────────

export interface AguiEvent {
  type: string;
  [key: string]: unknown;
}

export interface Interrupt {
  id: string;
  reason: string;
  message: string;
  expiresAt: string;
  metadata: { nonce: string };
}

type RunBody =
  | { text: string }
  | { resume: { interruptId: string; nonce: string; approved: boolean } };

/**
 * POSTs a RunAgentInput and yields AG-UI events as they arrive. `threadId` must equal the session id: the server
 * rejects anything else, and ignores any client-supplied tools, context or state.
 */
export async function* runAgent(token: string, sessionId: string, body: RunBody, signal?: AbortSignal): AsyncGenerator<AguiEvent> {
  const input = {
    threadId: sessionId,
    runId: crypto.randomUUID(),
    messages: "text" in body ? [{ id: crypto.randomUUID(), role: "user", content: body.text }] : [],
    tools: [],
    context: [],
    state: {},
    ...("resume" in body
      ? {
          resume: [
            {
              interruptId: body.resume.interruptId,
              status: body.resume.approved ? "resolved" : "cancelled",
              payload: { nonce: body.resume.nonce, approved: body.resume.approved },
            },
          ],
        }
      : {}),
  };
  const res = await fetch("/api/agui/run", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
    signal,
  });
  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => null)) as { ruleId?: string } | null;
    throw new ApiError(res.status, err?.ruleId ?? null);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) yield JSON.parse(data) as AguiEvent;
    }
  }
}

// ── Structured turn view (STATE_DELTA /view): display-only projections of the customer's own db records ──────

export interface ViewProduct {
  product_id: string;
  product_type: string;
  product_number_masked: string;
  currency: string;
  current_balance: number;
  credit_limit: number | null;
  product_status: string;
}

export interface ViewTransaction {
  transaction_id: string;
  transaction_date: string;
  merchant_name: string | null;
  amount: number;
  currency: string;
  amount_usd: number | null;
  transaction_status: string;
  channel: string;
  transaction_type: string;
  transaction_category: string | null;
}

export interface ViewDispute {
  dispute_id: string;
  transaction_ids: string[];
  reason: string;
  amount_usd: number;
  status: string;
  created_at: string;
}

export interface TurnView {
  products?: ViewProduct[];
  transactions?: ViewTransaction[];
  candidates?: ViewTransaction[];
  dispute?: ViewDispute;
  handoffId?: string;
}

// ── Home, cases and supervision read models ──────────────────────────────────────────────────────────────

export interface CustomerOverview {
  asOf: string;
  customer: { firstName: string; segment: string; country: string; status: string } | null;
  products: ViewProduct[];
  recent: ViewTransaction[];
  spending30d: { category: string; usd: number; count: number }[];
  monthly: { month: string; usd: number; count: number }[];
}

export interface CustomerCase {
  kind: "dispute" | "handoff";
  id: string;
  status: "received" | "in_review" | "queued" | "taken" | "resolved";
  createdAt: string;
  resolvedAt: string | null;
  transactionIds: string[];
  amountUsd: number | null;
  reason: string | null;
}

export type OutcomeKind = "answered" | "dispute_created" | "handoff" | "abstain" | "clarify" | "greeting" | "cancelled";

export interface OpsMetrics {
  since: string;
  sessions: number;
  turns: number;
  outcomes: Record<OutcomeKind, number>;
  automatedResolutionRate: number | null;
  latencyMs: { p50: number | null; p95: number | null };
  llm: { calls: number; tokens: number; costUsd: number };
  disputes: { count: number; amountUsd: number };
  queue: { queued: number; taken: number; resolved: number };
  escalationsByRule: { ruleId: string; count: number }[];
  intents: { label: string; count: number; avgConfidence: number }[];
  security: { ruleId: string; count: number }[];
  hourly: { hour: string; turns: number; handoffs: number }[];
}
