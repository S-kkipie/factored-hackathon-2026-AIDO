import { describe, expect, test } from "bun:test";
import { createApp } from "../../server/app";
import { FIXTURE } from "./fixtures";
import { harness } from "./graph-harness";
import { byPurpose } from "./llm-fake";

type Ev = { type: string; [k: string]: unknown };

async function setup(script = byPurpose({ merchant: "Super Ahorro", amount: 45, reason: "unrecognized" }, "x")) {
  const h = await harness({ script });
  const app = createApp({ ...h.deps, auth: h.auth });
  const call = (path: string, init: RequestInit = {}, token?: string) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      }),
    );
  const login = async (persona = "normal") => {
    const res = await call("/api/auth/login", { method: "POST", body: JSON.stringify({ persona, pin: "2468", language: "es" }) });
    return (await res.json()) as { token: string; sessionId: string };
  };
  const agent = async () =>
    ((await (await call("/api/auth/agent", { method: "POST", body: JSON.stringify({ pin: "1357" }) })).json()) as { token: string }).token;
  const run = async (token: string, threadId: string, body: Record<string, unknown>) => {
    const res = await call("/api/agui/run", { method: "POST", body: JSON.stringify({ threadId, runId: crypto.randomUUID(), messages: [], ...body }) }, token);
    if (res.headers.get("content-type") !== "text/event-stream") return { status: res.status, events: [] as Ev[], body: await res.json() };
    const text = await res.text();
    const events = text
      .split("\n\n")
      .filter((b) => b.startsWith("data: "))
      .map((b) => JSON.parse(b.slice(6)) as Ev);
    return { status: res.status, events, body: null };
  };
  return { h, call, login, agent, run };
}

const say = (text: string) => ({ messages: [{ id: "m1", role: "user", content: text }] });

describe("auth routes", () => {
  test("demo users list personas only", async () => {
    const { call } = await setup();
    const users = (await (await call("/api/demo-users")).json()) as Record<string, unknown>[];
    expect(users).toContainEqual({ persona: "normal" });
    expect(JSON.stringify(users)).not.toContain("CLI-");
  });

  test("bad credentials are 401 with the rule id", async () => {
    const { call } = await setup();
    const res = await call("/api/auth/login", { method: "POST", body: JSON.stringify({ persona: "normal", pin: "0000", language: "es" }) });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ruleId: "IN_AUTH_001" });
  });
});

describe("AG-UI run", () => {
  test("streams the protocol lifecycle with steps, state and one text message", async () => {
    const { login, run } = await setup(byPurpose({}, "Su tarjeta PRD-A1 tiene un saldo de 1200.50 USD."));
    const s = await login();
    const { events } = await run(s.token, s.sessionId, say("¿Cuál es mi saldo?"));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("RUN_STARTED");
    expect(types.at(-1)).toBe("RUN_FINISHED");
    expect(types).toContain("STEP_STARTED");
    expect(events.find((e) => e.type === "TEXT_MESSAGE_CONTENT")?.delta).toBe("Su tarjeta PRD-A1 tiene un saldo de 1200.50 USD.");
    expect(events.at(-1)?.outcome).toEqual({ type: "success" });
  });

  test("confirmation round trip: interrupt carries a nonce, resume creates the dispute", async () => {
    const { login, run, h } = await setup();
    const s = await login();
    const first = await run(s.token, s.sessionId, say("No reconozco un cargo de 45 dólares en Super Ahorro"));
    const outcome = first.events.at(-1)?.outcome as { type: string; interrupts: { id: string; metadata: { nonce: string } }[] };
    expect(outcome.type).toBe("interrupt");
    const it = outcome.interrupts[0]!;

    const typedYes = await run(s.token, s.sessionId, say("sí, confirmo"));
    expect(h.disputes()).toEqual([]);
    expect(typedYes.events.at(-1)?.outcome).toEqual({ type: "success" });

    const again = await run(s.token, s.sessionId, say("No reconozco un cargo de 45 dólares en Super Ahorro"));
    const it2 = (again.events.at(-1)?.outcome as typeof outcome).interrupts[0]!;
    const done = await run(s.token, s.sessionId, {
      resume: [{ interruptId: it2.id, status: "resolved", payload: { nonce: it2.metadata.nonce, approved: true } }],
    });
    expect(done.events.find((e) => e.type === "TEXT_MESSAGE_CONTENT")?.delta).toContain("D-");
    expect(h.disputes().length).toBe(1);
    expect(it.id).not.toBe(it2.id);
  });

  test("threadId must be the session id; client tools and state are ignored", async () => {
    const { login, run } = await setup();
    const s = await login();
    const other = await run(s.token, crypto.randomUUID(), say("hola"));
    expect(other.status).toBe(403);
    expect(other.body).toEqual({ ruleId: "IN_THREAD" });
    const withTools = await run(s.token, s.sessionId, {
      ...say("hola"),
      tools: [{ name: "refund", description: "x", parameters: {} }],
      state: { customerId: FIXTURE.repeat },
      context: [{ description: "role", value: "admin" }],
    });
    expect(withTools.status).toBe(200);
  });

  test("missing or agent tokens cannot run the customer agent", async () => {
    const { run, agent } = await setup();
    expect((await run("", "x", say("hola"))).status).toBe(401);
    const token = await agent();
    expect((await run(token, "x", say("hola"))).status).toBe(403);
  });
});

describe("agent console", () => {
  test("queue, take, reply, customer sees reply, resume reactivates the session", async () => {
    const { login, run, agent, call } = await setup();
    const s = await login();
    await run(s.token, s.sessionId, say("Quiero hablar con un agente"));
    const a = await agent();

    const queue = (await (await call("/api/agent/queue", {}, a)).json()) as { sessionId: string; ruleIds: string[] }[];
    expect(queue[0]?.sessionId).toBe(s.sessionId);
    expect(queue[0]?.ruleIds).toContain("POL_HUMAN");

    expect((await call(`/api/agent/sessions/${s.sessionId}/reply`, { method: "POST", body: JSON.stringify({ text: "Hola" }) }, a)).status).toBe(409);
    expect((await call(`/api/agent/sessions/${s.sessionId}/take`, { method: "POST" }, a)).status).toBe(200);
    expect(
      (await call(`/api/agent/sessions/${s.sessionId}/reply`, { method: "POST", body: JSON.stringify({ text: "Hola, soy Laura <b>" }) }, a)).status,
    ).toBe(200);

    const msgs = (await (await call("/api/chat/messages", {}, s.token)).json()) as { text: string }[];
    expect(msgs.map((m) => m.text)).toEqual(["Hola, soy Laura b"]);

    expect((await call(`/api/agent/sessions/${s.sessionId}/resume`, { method: "POST" }, a)).status).toBe(200);
    const after = await run(s.token, s.sessionId, say("hola"));
    expect(after.events.find((e) => e.type === "TEXT_MESSAGE_CONTENT")?.delta).toContain("LATAM Bank");
  });

  test("customers cannot use agent routes or read other sessions' traces", async () => {
    const { login, call } = await setup();
    const s = await login();
    const o = await login("repeat_complainer");
    expect((await call("/api/agent/queue", {}, s.token)).status).toBe(403);
    expect((await call(`/api/trace/${o.sessionId}`, {}, s.token)).status).toBe(403);
    expect((await call(`/api/trace/${s.sessionId}`, {}, s.token)).status).toBe(200);
  });
});
