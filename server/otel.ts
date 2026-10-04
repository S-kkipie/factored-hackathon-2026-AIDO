import type { AttrValue, SpanRecord, SpanSink } from "./trace";

type OtlpValue = { stringValue: string } | { doubleValue: number } | { intValue: string } | { boolValue: boolean } | { arrayValue: { values: OtlpValue[] } };

function value(v: AttrValue): OtlpValue | null {
  if (v === null) return null;
  if (Array.isArray(v)) return { arrayValue: { values: v.map((x) => ({ stringValue: String(x) })) } };
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: v };
}

const nanos = (ms: number): string => (BigInt(Math.round(ms * 1000)) * 1000n).toString();

/** OTLP/HTTP JSON for a batch of persisted spans. The raw session id is never sent; only the hashed conversation id. */
export function toOtlpJson(spans: SpanRecord[], service: string, environment: string): unknown {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: service } },
            { key: "deployment.environment", value: { stringValue: environment } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "aido", version: "1" },
            spans: spans.map((s) => {
              const start = Date.parse(s.started_at);
              const attrs = { ...s.attributes, "langfuse.session.id": s.attributes["gen_ai.conversation.id"] ?? null, "langfuse.environment": environment };
              return {
                traceId: s.trace_id,
                spanId: s.span_id,
                ...(s.parent_id ? { parentSpanId: s.parent_id } : {}),
                name: s.name,
                // OTLP SpanKind: CLIENT (3) for model calls, INTERNAL (1) for graph nodes and gates.
                kind: s.name.startsWith("chat ") ? 3 : 1,
                startTimeUnixNano: nanos(start),
                endTimeUnixNano: nanos(start + s.duration_ms),
                attributes: Object.entries(attrs).flatMap(([key, v]) => {
                  const val = value(v as AttrValue);
                  return val ? [{ key, value: val }] : [];
                }),
                // OTLP StatusCode: ERROR (2) when the span recorded an error, otherwise UNSET (0).
                status: { code: s.attributes["error.type"] ? 2 : 0 },
              };
            }),
          },
        ],
      },
    ],
  };
}

/**
 * Span sink that ships spans to Langfuse's OTLP endpoint (spec 8). Spans are batched (size or interval) and posted
 * as OTLP/HTTP JSON. Export is best effort: a failed post is dropped and never reaches the turn.
 */
export function createOtlpExporter(o: {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  fetch?: typeof fetch;
  maxBatch?: number;
  flushMs?: number;
  serviceName?: string;
  environment?: string;
}): SpanSink & { flush(): Promise<void>; shutdown(): Promise<void> } {
  const doFetch = o.fetch ?? fetch;
  const url = `${o.baseUrl.replace(/\/$/, "")}/api/public/otel/v1/traces`;
  const auth = `Basic ${Buffer.from(`${o.publicKey}:${o.secretKey}`).toString("base64")}`;
  const maxBatch = o.maxBatch ?? 50;
  let queue: SpanRecord[] = [];
  let inflight: Promise<void> = Promise.resolve();

  const send = (batch: SpanRecord[]) =>
    doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth, "x-langfuse-ingestion-version": "4" },
      body: JSON.stringify(toOtlpJson(batch, o.serviceName ?? "aido", o.environment ?? "demo")),
      signal: AbortSignal.timeout(5000),
    }).then(
      () => undefined,
      () => undefined,
    );

  const flush = async () => {
    if (queue.length === 0) return inflight;
    const batch = queue;
    queue = [];
    inflight = inflight.then(() => send(batch));
    return inflight;
  };

  const timer = setInterval(() => void flush(), o.flushMs ?? 5000);
  (timer as { unref?: () => void }).unref?.();

  return {
    push(span) {
      queue.push(span);
      if (queue.length >= maxBatch) void flush();
    },
    flush,
    async shutdown() {
      clearInterval(timer);
      await flush();
    },
  };
}
