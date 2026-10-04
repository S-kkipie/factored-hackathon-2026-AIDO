import { describe, expect, test } from "bun:test";
import { createApp } from "../../server/app";
import type { SpanRecord } from "../../server/trace";
import { groupTrace } from "../../web/src/lib/trace";
import { harness } from "../server/graph-harness";
import { byPurpose } from "../server/llm-fake";

const span = (p: Partial<SpanRecord> & Pick<SpanRecord, "name" | "trace_id" | "started_at" | "duration_ms">): SpanRecord => ({
  span_id: crypto.randomUUID().slice(0, 16),
  session_id: "s",
  parent_id: null,
  attributes: {},
  ...p,
});

describe("groupTrace", () => {
  test("groups by trace, orders turns and steps by start, sums cost and LLM calls", () => {
    const turns = groupTrace([
      span({ name: "bank.node.respond", trace_id: "b", started_at: "2026-10-03T10:01:00.100Z", duration_ms: 900, attributes: { "bank.rule_ids": ["POL_READ"] } }),
      span({
        name: "chat gemini-3.8-flash",
        trace_id: "b",
        started_at: "2026-10-03T10:01:00.200Z",
        duration_ms: 700,
        attributes: { "gen_ai.request.model": "gemini-3.8-flash", "gen_ai.usage.input_tokens": 500, "gen_ai.usage.output_tokens": 80, "bank.cost_usd": 0.000675 },
      }),
      span({
        name: "bank.node.router",
        trace_id: "b",
        started_at: "2026-10-03T10:01:00.000Z",
        duration_ms: 50,
        attributes: { "bank.router.label": "check_balance", "bank.router.confidence": 0.98, "bank.router.name": "embed-lr", "bank.rule_ids": [] },
      }),
      span({ name: "bank.node.greet", trace_id: "a", started_at: "2026-10-03T10:00:00.000Z", duration_ms: 3 }),
      span({ name: "bank.node.policy", trace_id: "b", started_at: "2026-10-03T10:01:00.060Z", duration_ms: 2, attributes: { "bank.gate.decision": "allow", "bank.rule_ids": ["POL_READ"] } }),
    ]);
    expect(turns.map((t) => [t.traceId, t.index])).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    const b = turns[1]!;
    expect(b.steps.map((s) => [s.name, s.kind])).toEqual([
      ["router", "node"],
      ["policy", "node"],
      ["respond", "node"],
      ["chat", "chat"],
    ]);
    expect(b.steps[0]!.router).toEqual({ label: "check_balance", confidence: 0.98, name: "embed-lr" });
    expect(b.steps[1]!.decision).toBe("allow");
    expect(b.steps[3]).toMatchObject({ model: "gemini-3.8-flash", inputTokens: 500, outputTokens: 80, costUsd: 0.000675 });
    expect(b.llmCalls).toBe(1);
    expect(b.costUsd).toBeCloseTo(0.000675, 9);
    expect(b.durationMs).toBe(1000);
    expect(b.ruleIds).toEqual(["POL_READ"]);
  });

  test("an empty trace has no turns; errors are surfaced", () => {
    expect(groupTrace([])).toEqual([]);
    const [t] = groupTrace([span({ name: "bank.node.fetch", trace_id: "x", started_at: "2026-10-03T10:00:00Z", duration_ms: 5, attributes: { "error.type": "ToolError" } })]);
    expect(t!.steps[0]!.error).toBe("ToolError");
  });

  test("on equal start times the enclosing node precedes its chat span; a confirmation pause is not an error", () => {
    const [t] = groupTrace([
      span({ name: "chat gemini-3.8-flash", trace_id: "x", started_at: "2026-10-03T10:00:00.000Z", duration_ms: 700, attributes: { "bank.cost_usd": 0.0002 } }),
      span({ name: "bank.node.extract", trace_id: "x", started_at: "2026-10-03T10:00:00.000Z", duration_ms: 710 }),
      span({ name: "bank.node.confirm", trace_id: "x", started_at: "2026-10-03T10:00:00.800Z", duration_ms: 1, attributes: { "error.type": "GraphInterrupt" } }),
    ]);
    expect(t!.steps.map((s) => s.name)).toEqual(["extract", "chat", "confirm"]);
    expect(t!.steps[2]).toMatchObject({ error: null, interrupted: true });
    expect(t!.steps[0]!.interrupted).toBe(false);
  });

  test("real spans from a server turn group into one turn with a router step", async () => {
    const h = await harness({ script: byPurpose({}, "Su tarjeta PRD-A1 tiene un saldo de 1200.50 USD.") });
    const app = createApp({ ...h.deps, auth: h.auth });
    const post = (path: string, body: unknown, token?: string) =>
      app.handle(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(body),
        }),
      );
    const s = (await (await post("/api/auth/login", { persona: "normal", pin: "2468", language: "es" })).json()) as { token: string; sessionId: string };
    await (await post("/api/agui/run", { threadId: s.sessionId, runId: "r1", messages: [{ id: "m", role: "user", content: "¿Cuál es mi saldo?" }] }, s.token)).text();
    const spans = (await (
      await app.handle(new Request(`http://localhost/api/trace/${s.sessionId}`, { headers: { authorization: `Bearer ${s.token}` } }))
    ).json()) as SpanRecord[];
    const turns = groupTrace(spans);
    expect(turns.length).toBe(1);
    expect(turns[0]!.steps[0]!.name).toBe("router");
    expect(turns[0]!.steps[0]!.router?.label).toBe("check_balance");
    expect(turns[0]!.llmCalls).toBeGreaterThanOrEqual(1);
  });
});
