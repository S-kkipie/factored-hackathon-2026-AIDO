import { Elysia, t } from "elysia";
import { agentReply, listQueue, resolveSession, sessionMessages, takeSession } from "./agent";
import { sseResponse, startRun, toAgui } from "./api/agui";
import { appendAudit } from "./audit";
import { type Auth, AuthError, type SessionStatus } from "./auth";
import type { TurnDeps } from "./graph/turn";
import { customerCases, customerOverview, opsMetrics } from "./insights";
import { listSpans } from "./trace";

export interface AppDeps extends TurnDeps {
  auth: Auth;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const bearer = (req: Request) => req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";

/**
 * HTTP surface (spec 9). Customer chat speaks AG-UI over SSE; the agent console and trace view are plain REST.
 * Every route derives identity from the JWT; ids in paths are checked against it.
 */
export function createApp(deps: AppDeps) {
  const authed = async (req: Request, allow: readonly SessionStatus[] = ["active"]) => {
    try {
      return { session: await deps.auth.verify(bearer(req), allow) };
    } catch (e) {
      if (e instanceof AuthError) return { error: json(401, { ruleId: e.ruleId }) };
      throw e;
    }
  };
  const asAgent = async (req: Request) => {
    const r = await authed(req);
    if ("error" in r) return r;
    if (r.session.role !== "agent") return { error: json(403, { ruleId: "IN_ROLE" }) };
    return r;
  };

  return new Elysia()
    .onError(({ code, error }) => {
      // Elysia's own 4xx responses (bad body, unknown route, unparsable request) pass through unchanged.
      if (code === "VALIDATION" || code === "NOT_FOUND" || code === "PARSE") return;
      // Anything else (a thrown Error from a route, e.g. a rethrown non-AuthError) is an internal failure: log
      // only the error name server-side and never let its message (which may contain internal paths or SQL) reach the client.
      console.error(error instanceof Error ? error.name : "unknown error");
      return json(500, { error: "internal" });
    })
    .get("/api/health", () => ({ ok: true }))
    .get("/api/demo-users", async () => (await deps.serving.demoUsers()).map((u) => ({ persona: u.persona })))
    .post(
      "/api/auth/login",
      async ({ body }) => {
        try {
          const { token, session } = await deps.auth.login(body.persona, body.pin, body.language);
          return { token, sessionId: session.sessionId, language: session.language, expiresAt: session.expiresAt };
        } catch (e) {
          if (e instanceof AuthError) return json(401, { ruleId: e.ruleId });
          throw e;
        }
      },
      {
        body: t.Object({
          persona: t.String({ maxLength: 40 }),
          pin: t.String({ maxLength: 12 }),
          language: t.Union([t.Literal("es"), t.Literal("pt")]),
        }),
      },
    )
    .post(
      "/api/auth/agent",
      async ({ body }) => {
        try {
          const { token, session } = await deps.auth.agentLogin(body.pin);
          return { token, sessionId: session.sessionId, expiresAt: session.expiresAt };
        } catch (e) {
          if (e instanceof AuthError) return json(401, { ruleId: e.ruleId });
          throw e;
        }
      },
      { body: t.Object({ pin: t.String({ maxLength: 12 }) }) },
    )
    .post("/api/auth/logout", async ({ request }) => {
      const r = await authed(request, ["active", "handed_off"]);
      if ("error" in r) return r.error;
      await deps.auth.revoke(r.session.sessionId);
      return { ok: true };
    })
    .post("/api/agui/run", async ({ request }) => {
      const r = await authed(request, ["active", "handed_off"]);
      if ("error" in r) return r.error;
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json(400, { ruleId: "IN_EMPTY" });
      }
      const run = startRun(deps, r.session, body);
      if ("error" in run) {
        await appendAudit(deps.ops, { sessionId: r.session.sessionId, kind: "agui_rejected", ruleId: run.error.ruleId, payload: {} });
        return json(run.error.status, { ruleId: run.error.ruleId });
      }
      return sseResponse(toAgui(run.input, run.events), request.headers.get("accept") ?? undefined);
    })
    .get("/api/chat/messages", async ({ request, query }) => {
      const r = await authed(request, ["active", "handed_off"]);
      if ("error" in r) return r.error;
      if (r.session.role !== "customer") return json(403, { ruleId: "IN_ROLE" });
      return (await sessionMessages(deps.ops, r.session.sessionId, Number(query.after ?? 0) || 0)).filter((m) => m.author === "agent");
    })
    .get("/api/me/overview", async ({ request }) => {
      const r = await authed(request, ["active", "handed_off"]);
      if ("error" in r) return r.error;
      if (r.session.role !== "customer" || !r.session.customerId) return json(403, { ruleId: "IN_ROLE" });
      return customerOverview(deps.serving, r.session.customerId.v);
    })
    .get("/api/me/cases", async ({ request }) => {
      const r = await authed(request, ["active", "handed_off"]);
      if ("error" in r) return r.error;
      if (r.session.role !== "customer" || !r.session.customerId) return json(403, { ruleId: "IN_ROLE" });
      return customerCases(deps.ops, r.session.customerId.v);
    })
    .get("/api/ops/metrics", async ({ request, query }) => {
      const r = await asAgent(request);
      if ("error" in r) return r.error;
      const hours = Math.min(24 * 30, Math.max(1, Math.trunc(Number(query.hours ?? 168)) || 168));
      return opsMetrics(deps.ops, (deps.now ?? (() => new Date()))(), hours);
    })
    .get("/api/agent/queue", async ({ request }) => {
      const r = await asAgent(request);
      if ("error" in r) return r.error;
      return listQueue(deps.ops);
    })
    .get("/api/agent/sessions/:id/messages", async ({ request, params }) => {
      const r = await asAgent(request);
      if ("error" in r) return r.error;
      return sessionMessages(deps.ops, params.id);
    })
    .post("/api/agent/sessions/:id/take", async ({ request, params }) => {
      const r = await asAgent(request);
      if ("error" in r) return r.error;
      return (await takeSession(deps.ops, params.id, r.session.sessionId)) ? { ok: true } : json(409, { ok: false });
    })
    .post(
      "/api/agent/sessions/:id/reply",
      async ({ request, params, body }) => {
        const r = await asAgent(request);
        if ("error" in r) return r.error;
        return (await agentReply(deps.ops, params.id, r.session.sessionId, body.text)) ? { ok: true } : json(409, { ok: false });
      },
      { body: t.Object({ text: t.String({ minLength: 1, maxLength: 500 }) }) },
    )
    .post("/api/agent/sessions/:id/resume", async ({ request, params }) => {
      const r = await asAgent(request);
      if ("error" in r) return r.error;
      return (await resolveSession(deps.ops, deps.auth, params.id, r.session.sessionId)) ? { ok: true } : json(409, { ok: false });
    })
    .get("/api/trace/:session", async ({ request, params }) => {
      const r = await authed(request, ["active", "handed_off"]);
      if ("error" in r) return r.error;
      if (r.session.role !== "agent" && r.session.sessionId !== params.session) return json(403, { ruleId: "IN_ROLE" });
      return listSpans(deps.ops, params.session);
    });
}

export type App = ReturnType<typeof createApp>;
