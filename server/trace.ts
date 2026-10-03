import type { Sql } from "./db/sql";
import { sha256Hex } from "./hash";

export type AttrValue = string | number | boolean | null | string[];
export type Attributes = Record<string, AttrValue>;

export interface SpanRecord {
  span_id: string;
  trace_id: string;
  session_id: string;
  parent_id: string | null;
  name: string;
  started_at: string;
  duration_ms: number;
  attributes: Attributes;
}

/** The conversation id exported in spans is a hash: raw session ids never leave the ops schema. */
export const conversationId = (sessionId: string): string => sha256Hex(`conv:${sessionId}`).slice(0, 32);

/**
 * Records spans with OpenTelemetry GenAI attribute names into `ops.spans` (source for the trace view).
 * Export to Langfuse over OTLP is plan 6; span names and attributes already follow the conventions.
 * Content is never recorded: only ids, counts, rule ids and decisions.
 */
export class Tracer {
  readonly traceId: string;

  constructor(
    private readonly ops: Sql,
    readonly sessionId: string,
    traceId?: string,
  ) {
    this.traceId = traceId ?? crypto.randomUUID().replaceAll("-", "");
  }

  async record(
    name: string,
    attributes: Attributes,
    startedAt: Date,
    durationMs: number,
    parentId: string | null = null,
  ): Promise<string> {
    const spanId = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
    await this.ops.run(
      "insert into ops.spans (span_id, trace_id, session_id, parent_id, name, started_at, duration_ms, attributes) values ($1, $2, $3, $4, $5, $6, $7, $8)",
      [
        spanId,
        this.traceId,
        this.sessionId,
        parentId,
        name,
        startedAt.toISOString(),
        durationMs,
        JSON.stringify({ "gen_ai.conversation.id": conversationId(this.sessionId), ...attributes }),
      ],
    );
    return spanId;
  }

  /** Times `fn` and records it; attributes set through `set` are recorded even when `fn` throws. */
  async span<T>(name: string, attributes: Attributes, fn: (set: (k: string, v: AttrValue) => void) => Promise<T> | T): Promise<T> {
    const started = new Date();
    const t0 = performance.now();
    const attrs: Attributes = { ...attributes };
    try {
      return await fn((k, v) => {
        attrs[k] = v;
      });
    } catch (e) {
      attrs["error.type"] = e instanceof Error ? e.name : "unknown";
      throw e;
    } finally {
      await this.record(name, attrs, started, performance.now() - t0);
    }
  }
}

export async function listSpans(ops: Sql, sessionId: string): Promise<SpanRecord[]> {
  const rows = await ops.all<Omit<SpanRecord, "attributes"> & { attributes: string }>(
    "select span_id, trace_id, session_id, parent_id, name, started_at, duration_ms, attributes from ops.spans where session_id = $1 order by started_at, ord",
    [sessionId],
  );
  return rows.map((r) => ({ ...r, attributes: JSON.parse(r.attributes) as Attributes }));
}
