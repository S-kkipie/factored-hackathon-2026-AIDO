import type { Database } from "bun:sqlite";
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

/** The conversation id exported in spans is a hash: raw session ids never leave ops.sqlite. */
export const conversationId = (sessionId: string): string => sha256Hex(`conv:${sessionId}`).slice(0, 32);

/**
 * Records spans with OpenTelemetry GenAI attribute names into ops.sqlite (source for the trace view).
 * Export to Langfuse over OTLP is plan 6; span names and attributes already follow the conventions.
 * Content is never recorded: only ids, counts, rule ids and decisions.
 */
export class Tracer {
  readonly traceId: string;

  constructor(
    private readonly ops: Database,
    readonly sessionId: string,
    traceId?: string,
  ) {
    this.traceId = traceId ?? crypto.randomUUID().replaceAll("-", "");
  }

  record(name: string, attributes: Attributes, startedAt: Date, durationMs: number, parentId: string | null = null): string {
    const spanId = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
    this.ops
      .query(
        "insert into spans (span_id, trace_id, session_id, parent_id, name, started_at, duration_ms, attributes) values (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        spanId,
        this.traceId,
        this.sessionId,
        parentId,
        name,
        startedAt.toISOString(),
        durationMs,
        JSON.stringify({ "gen_ai.conversation.id": conversationId(this.sessionId), ...attributes }),
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
      this.record(name, attrs, started, performance.now() - t0);
    }
  }
}

export function listSpans(ops: Database, sessionId: string): SpanRecord[] {
  return ops
    .query<Omit<SpanRecord, "attributes"> & { attributes: string }, [string]>(
      "select * from spans where session_id = ? order by started_at, rowid",
    )
    .all(sessionId)
    .map((r) => ({ ...r, attributes: JSON.parse(r.attributes) as Attributes }));
}
