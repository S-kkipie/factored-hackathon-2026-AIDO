import { describe, expect, test } from "bun:test";
import { createOtlpExporter, toOtlpJson } from "../../server/otel";
import { Tracer, type SpanRecord } from "../../server/trace";
import { harness } from "./graph-harness";
import { makeOps } from "./fixtures";

const span = (p: Partial<SpanRecord> = {}): SpanRecord => ({
  span_id: "aaaaaaaaaaaaaaaa",
  trace_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  session_id: "raw-session-id",
  parent_id: null,
  name: "bank.node.router",
  started_at: "2026-10-04T10:00:00.000Z",
  duration_ms: 12.5,
  attributes: { "gen_ai.conversation.id": "c0ffee", "bank.rule_ids": ["POL_READ"], "bank.router.confidence": 0.97, "bank.gate.decision": "allow", "x.flag": true },
  ...p,
});

describe("toOtlpJson", () => {
  test("maps spans to OTLP/JSON with nanosecond times, typed attributes and the hashed session id only", () => {
    const body = toOtlpJson([span()], "aido", "demo") as {
      resourceSpans: { resource: { attributes: { key: string; value: Record<string, unknown> }[] }; scopeSpans: { spans: Record<string, unknown>[] }[] }[];
    };
    const rs = body.resourceSpans[0]!;
    expect(rs.resource.attributes).toContainEqual({ key: "service.name", value: { stringValue: "aido" } });
    const s = rs.scopeSpans[0]!.spans[0]! as { traceId: string; spanId: string; name: string; startTimeUnixNano: string; endTimeUnixNano: string; attributes: { key: string; value: Record<string, unknown> }[] };
    expect(s.traceId).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(s.spanId).toBe("aaaaaaaaaaaaaaaa");
    expect(s.startTimeUnixNano).toBe("1791108000000000000");
    expect(s.endTimeUnixNano).toBe("1791108000012500000");
    expect(s.attributes).toContainEqual({ key: "bank.rule_ids", value: { arrayValue: { values: [{ stringValue: "POL_READ" }] } } });
    expect(s.attributes).toContainEqual({ key: "bank.router.confidence", value: { doubleValue: 0.97 } });
    expect(s.attributes).toContainEqual({ key: "x.flag", value: { boolValue: true } });
    expect(s.attributes).toContainEqual({ key: "langfuse.session.id", value: { stringValue: "c0ffee" } });
    expect(JSON.stringify(body)).not.toContain("raw-session-id");
  });
});

describe("createOtlpExporter", () => {
  test("batches, posts to the Langfuse OTLP endpoint with Basic auth, and never throws", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let fail = false;
    const exporter = createOtlpExporter({
      baseUrl: "https://cloud.langfuse.com",
      publicKey: "pk-lf-1",
      secretKey: "sk-lf-2",
      maxBatch: 2,
      flushMs: 60_000,
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        if (fail) throw new Error("network down");
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    exporter.push(span({ span_id: "1111111111111111" }));
    expect(calls.length).toBe(0);
    exporter.push(span({ span_id: "2222222222222222" }));
    await exporter.flush();
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://cloud.langfuse.com/api/public/otel/v1/traces");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from("pk-lf-1:sk-lf-2").toString("base64")}`);
    expect(headers["x-langfuse-ingestion-version"]).toBe("4");
    expect(headers["content-type"]).toBe("application/json");
    fail = true;
    exporter.push(span());
    await exporter.shutdown();
    expect(calls.length).toBe(2);
  });

  test("the Tracer forwards each recorded span to its sink", () => {
    const pushed: SpanRecord[] = [];
    const tracer = new Tracer(makeOps(), "s1", undefined, { push: (s) => pushed.push(s) });
    tracer.record("bank.node.greet", { "bank.node": "greet" }, new Date("2026-10-04T10:00:00Z"), 3);
    expect(pushed.length).toBe(1);
    expect(pushed[0]!.name).toBe("bank.node.greet");
    expect(pushed[0]!.attributes["gen_ai.conversation.id"]).toBeTruthy();
  });
});

describe("end-of-turn flush", () => {
  test("a completed turn triggers a best-effort flush on the span sink", async () => {
    const h = await harness();
    let flushed = 0;
    h.deps.sink = { push: () => {}, flush: async () => { flushed += 1; } };
    await h.send("Hola");
    expect(flushed).toBe(1);
  });

  test("a sink without flush() does not break the turn", async () => {
    const h = await harness();
    h.deps.sink = { push: () => {} };
    const events = await h.send("Hola");
    expect(events.length).toBeGreaterThan(0);
  });
});
