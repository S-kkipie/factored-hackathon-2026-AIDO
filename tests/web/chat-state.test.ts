import { describe, expect, test } from "bun:test";
import { HttpAgent } from "@ag-ui/client";
import { type BaseEvent, EventType } from "@ag-ui/core";
import { createApp } from "../../server/app";
import { type ChatAction, type ChatState, chatReducer, initialChat } from "../../web/src/lib/chat-state";
import { harness } from "../server/graph-harness";
import { byPurpose } from "../server/llm-fake";

const ev = (e: Record<string, unknown>): ChatAction => ({ type: "event", event: e as unknown as BaseEvent });
const reduce = (actions: ChatAction[], from: ChatState = initialChat) => actions.reduce(chatReducer, from);

describe("chatReducer", () => {
  test("a run streams steps, route, decision and one assistant message", () => {
    const s = reduce([
      { type: "user", id: "u1", text: "¿Saldo?" },
      ev({ type: EventType.RUN_STARTED, threadId: "t", runId: "r" }),
      ev({ type: EventType.STEP_STARTED, stepName: "router" }),
      ev({ type: EventType.STATE_DELTA, delta: [{ op: "add", path: "/route", value: { label: "check_balance", confidence: 0.97 } }] }),
      ev({ type: EventType.STATE_DELTA, delta: [{ op: "add", path: "/decision", value: { action: "allow", ruleIds: ["POL_READ"] } }] }),
      ev({ type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" }),
      ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "Su saldo " }),
      ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "es 10 USD." }),
      ev({ type: EventType.TEXT_MESSAGE_END, messageId: "m1" }),
    ]);
    expect(s.running).toBe(true);
    expect(s.step).toBe("router");
    expect(s.route).toEqual({ label: "check_balance", confidence: 0.97 });
    expect(s.decision).toEqual({ action: "allow", ruleIds: ["POL_READ"] });
    expect(s.lines).toEqual([
      { id: "u1", author: "user", text: "¿Saldo?" },
      { id: "m1", author: "assistant", text: "Su saldo es 10 USD." },
    ]);
    const done = reduce(
      [
        ev({ type: EventType.STATE_DELTA, delta: [{ op: "add", path: "/outcome", value: "answered" }, { op: "add", path: "/ruleIds", value: ["POL_READ"] }] }),
        ev({ type: EventType.RUN_FINISHED, threadId: "t", runId: "r", outcome: { type: "success" } }),
      ],
      s,
    );
    expect(done.running).toBe(false);
    expect(done.step).toBeNull();
    expect(done.outcome).toBe("answered");
    expect(done.ruleIds).toEqual(["POL_READ"]);
    expect(done.pending).toBeNull();
  });

  test("an interrupt becomes a pending confirmation; resume_sent clears it and marks the turn running again", () => {
    const s = reduce([
      ev({ type: EventType.RUN_STARTED, threadId: "t", runId: "r" }),
      ev({
        type: EventType.RUN_FINISHED,
        threadId: "t",
        runId: "r",
        outcome: {
          type: "interrupt",
          interrupts: [{ id: "i1", reason: "confirm_dispute", message: "¿Confirmas?", expiresAt: "2026-06-17T10:00:00Z", metadata: { nonce: "n1" } }],
        },
      }),
    ]);
    expect(s.pending).toEqual({ interruptId: "i1", message: "¿Confirmas?", nonce: "n1", expiresAt: "2026-06-17T10:00:00Z" });
    expect(s.running).toBe(false);
    const resumed = chatReducer(s, { type: "resume_sent" });
    expect(resumed.pending).toBeNull();
    // Optimistic: the confirm/cancel click itself starts a new run, before RUN_STARTED arrives, so a second
    // click (or a fast composer submit) can't race in a second runAgent() call.
    expect(resumed.running).toBe(true);
  });

  test("a user action optimistically marks the turn running before RUN_STARTED arrives", () => {
    const s = chatReducer(initialChat, { type: "user", id: "u1", text: "Hola" });
    expect(s.running).toBe(true);
    expect(s.error).toBeNull();
    expect(chatReducer(s, { type: "failed", message: "x" }).running).toBe(false);
  });

  test("case and handoff ids are kept; a handoff marks the chat as handed off", () => {
    const s = reduce([
      ev({ type: EventType.RUN_STARTED, threadId: "t", runId: "r" }),
      ev({ type: EventType.STATE_DELTA, delta: [{ op: "add", path: "/outcome", value: "handoff" }, { op: "add", path: "/handoffId", value: "H-1" }] }),
    ]);
    expect(s.handoffId).toBe("H-1");
    expect(s.handedOff).toBe(true);
    const c = reduce([ev({ type: EventType.STATE_DELTA, delta: [{ op: "add", path: "/caseId", value: "D-9" }] })]);
    expect(c.caseId).toBe("D-9");
  });

  test("a new run keeps the case id from earlier turns but resets per-turn state", () => {
    const s = reduce([
      ev({ type: EventType.STATE_DELTA, delta: [{ op: "add", path: "/caseId", value: "D-9" }, { op: "add", path: "/route", value: { label: "x", confidence: 1 } }] }),
      ev({ type: EventType.RUN_STARTED, threadId: "t", runId: "r2" }),
    ]);
    expect(s.caseId).toBe("D-9");
    expect(s.route).toBeNull();
    expect(s.error).toBeNull();
  });

  test("agent messages are appended once, in order; session back to active adds a notice", () => {
    const handed = reduce([ev({ type: EventType.STATE_DELTA, delta: [{ op: "add", path: "/outcome", value: "handed_off" }] })]);
    const a = chatReducer(handed, { type: "agent_messages", messages: [{ id: 3, text: "Hola" }, { id: 4, text: "Revisé tu caso" }] });
    const b = chatReducer(a, { type: "agent_messages", messages: [{ id: 4, text: "Revisé tu caso" }, { id: 5, text: "Listo" }] });
    expect(b.lines.map((l) => [l.author, l.text])).toEqual([
      ["agent", "Hola"],
      ["agent", "Revisé tu caso"],
      ["agent", "Listo"],
    ]);
    expect(b.lastAgentMessageId).toBe(5);
    const back = chatReducer(b, { type: "session_status", status: "active", notice: "De vuelta" });
    expect(back.handedOff).toBe(false);
    expect(back.lines.at(-1)).toMatchObject({ author: "system", text: "De vuelta" });
    expect(chatReducer(back, { type: "session_status", status: "active", notice: "De vuelta" }).lines.length).toBe(back.lines.length);
  });

  test("a 'handed_off' session_status marks the chat handed off with no notice line", () => {
    const s = chatReducer(initialChat, { type: "session_status", status: "handed_off", notice: "" });
    expect(s.handedOff).toBe(true);
    expect(s.lines).toEqual([]);
    // Idempotent: a second report of the same status doesn't add another line or change identity-sensitive state.
    const again = chatReducer(s, { type: "session_status", status: "handed_off", notice: "" });
    expect(again).toBe(s);
  });

  test("'handed_off' then 'active' round-trips through the notice-adding path", () => {
    const handed = chatReducer(initialChat, { type: "session_status", status: "handed_off", notice: "" });
    const back = chatReducer(handed, { type: "session_status", status: "active", notice: "De vuelta" });
    expect(back.handedOff).toBe(false);
    expect(back.lines.at(-1)).toMatchObject({ author: "system", text: "De vuelta" });
  });

  test("RUN_ERROR and client failures stop the run with an error", () => {
    const s = reduce([
      ev({ type: EventType.RUN_STARTED, threadId: "t", runId: "r" }),
      ev({ type: EventType.RUN_ERROR, message: "The assistant could not complete this turn." }),
    ]);
    expect(s.running).toBe(false);
    expect(s.error).toBe("The assistant could not complete this turn.");
    expect(chatReducer(initialChat, { type: "failed", message: "x" })).toMatchObject({ running: false, error: "x" });
  });
});

describe("HttpAgent against the real server", () => {
  test("confirm round trip: interrupt with nonce, resume creates the case", async () => {
    const h = await harness({ script: byPurpose({ merchant: "Super Ahorro", amount: 45, reason: "unrecognized" }, "x") });
    const app = createApp({ ...h.deps, auth: h.auth });
    const login = (await (
      await app.handle(
        new Request("http://localhost/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ persona: "normal", pin: "2468", language: "es" }),
        }),
      )
    ).json()) as { token: string; sessionId: string };

    const agent = new HttpAgent({
      url: "http://localhost/api/agui/run",
      threadId: login.sessionId,
      headers: { authorization: `Bearer ${login.token}` },
      fetch: (url, init) => app.handle(new Request(url, init)),
    });
    let state = initialChat;
    agent.subscribe({
      onEvent: ({ event }) => {
        state = chatReducer(state, { type: "event", event });
      },
    });

    agent.addMessage({ id: "u1", role: "user", content: "No reconozco un cargo de 45 dólares en Super Ahorro" });
    await agent.runAgent({ runId: crypto.randomUUID() });
    const pending = state.pending!;
    expect(pending.nonce.length).toBeGreaterThan(8);
    expect(h.disputes()).toEqual([]);

    state = chatReducer(state, { type: "resume_sent" });
    await agent.runAgent({
      runId: crypto.randomUUID(),
      resume: [{ interruptId: pending.interruptId, status: "resolved", payload: { nonce: pending.nonce, approved: true } }],
    });
    expect(state.caseId).toMatch(/^D-/);
    expect(state.outcome).toBe("dispute_created");
    expect(h.disputes().length).toBe(1);
    expect(state.lines.at(-1)?.text).toContain(state.caseId!);
  });

  test("cancel sends a cancelled resume and creates nothing", async () => {
    const h = await harness({ script: byPurpose({ merchant: "Super Ahorro", amount: 45, reason: "unrecognized" }, "x") });
    const app = createApp({ ...h.deps, auth: h.auth });
    const login = (await (
      await app.handle(
        new Request("http://localhost/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ persona: "normal", pin: "2468", language: "es" }),
        }),
      )
    ).json()) as { token: string; sessionId: string };
    const agent = new HttpAgent({
      url: "http://localhost/api/agui/run",
      threadId: login.sessionId,
      headers: { authorization: `Bearer ${login.token}` },
      fetch: (url, init) => app.handle(new Request(url, init)),
    });
    let state = initialChat;
    agent.subscribe({ onEvent: ({ event }) => void (state = chatReducer(state, { type: "event", event })) });
    agent.addMessage({ id: "u1", role: "user", content: "No reconozco un cargo de 45 dólares en Super Ahorro" });
    await agent.runAgent({ runId: crypto.randomUUID() });
    const pending = state.pending!;
    await agent.runAgent({
      runId: crypto.randomUUID(),
      resume: [{ interruptId: pending.interruptId, status: "cancelled", payload: { nonce: pending.nonce } }],
    });
    expect(state.outcome).toBe("cancelled");
    expect(h.disputes()).toEqual([]);
  });
});
