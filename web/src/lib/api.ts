import type { ChatMessage, QueueItem } from "../../../server/agent";
import type { Language, Role, SessionStatus } from "../../../server/auth";
import type { HandoffCard } from "../../../server/tools";
import type { SpanRecord } from "../../../server/trace";

export type { ChatMessage, HandoffCard, Language, QueueItem, Role, SessionStatus, SpanRecord };

export interface LoginResult {
  token: string;
  sessionId: string;
  language: Language;
  expiresAt: number;
}

export interface AgentLoginResult {
  token: string;
  sessionId: string;
  expiresAt: number;
}

export interface SessionInfo {
  sessionId: string;
  role: Role;
  language: Language;
  status: SessionStatus;
  expiresAt: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly ruleId: string | null,
  ) {
    super(`HTTP ${status}${ruleId ? ` ${ruleId}` : ""}`);
  }
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Typed client for the REST routes (spec 9). Types come from the server modules themselves, so a server change
 * that breaks the UI fails `tsc -p web`. The AG-UI chat stream does not go through here (see useChat).
 */
export function createApi(opts: { token: () => string | null; fetch?: Fetch; base?: string }) {
  const doFetch: Fetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const base = opts.base ?? "";

  async function call<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const token = opts.token();
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await doFetch(`${base}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!res.ok) {
      let ruleId: string | null = null;
      try {
        const body = (await res.json()) as { ruleId?: unknown };
        if (typeof body.ruleId === "string") ruleId = body.ruleId;
      } catch {
        // Non-JSON error body: the status alone describes the failure.
      }
      throw new ApiError(res.status, ruleId);
    }
    return (await res.json()) as T;
  }

  const id = encodeURIComponent;
  return {
    demoUsers: () => call<{ persona: string }[]>("/api/demo-users"),
    login: (persona: string, pin: string, language: Language) =>
      call<LoginResult>("/api/auth/login", { method: "POST", body: { persona, pin, language } }),
    agentLogin: (pin: string) => call<AgentLoginResult>("/api/auth/agent", { method: "POST", body: { pin } }),
    logout: () => call<{ ok: true }>("/api/auth/logout", { method: "POST" }),
    session: () => call<SessionInfo>("/api/session"),
    chatMessages: (after: number) => call<ChatMessage[]>(`/api/chat/messages?after=${after}`),
    queue: () => call<QueueItem[]>("/api/agent/queue"),
    sessionMessages: (sessionId: string) => call<ChatMessage[]>(`/api/agent/sessions/${id(sessionId)}/messages`),
    take: (sessionId: string) => call<{ ok: true }>(`/api/agent/sessions/${id(sessionId)}/take`, { method: "POST" }),
    reply: (sessionId: string, text: string) =>
      call<{ ok: true }>(`/api/agent/sessions/${id(sessionId)}/reply`, { method: "POST", body: { text } }),
    resolve: (sessionId: string) => call<{ ok: true }>(`/api/agent/sessions/${id(sessionId)}/resume`, { method: "POST" }),
    trace: (sessionId: string) => call<SpanRecord[]>(`/api/trace/${id(sessionId)}`),
  };
}

export type Api = ReturnType<typeof createApi>;
