import type { SpanRecord } from "./api";

export interface TraceStep {
  name: string;
  kind: "node" | "chat";
  startedAt: string;
  durationMs: number;
  ruleIds: string[];
  decision: string | null;
  router: { label: string; confidence: number; name: string } | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  error: string | null;
  /** The run paused here for an out-of-band confirmation (spec 3.2-5). */
  interrupted: boolean;
}

export interface TraceTurn {
  traceId: string;
  /** 1-based, in start order. A confirmation resume is its own run, so it is its own turn here. */
  index: number;
  startedAt: string;
  durationMs: number;
  costUsd: number;
  llmCalls: number;
  ruleIds: string[];
  steps: TraceStep[];
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const ms = (iso: string) => Date.parse(iso);

function toStep(s: SpanRecord): TraceStep {
  const a = s.attributes;
  const chat = s.name.startsWith("chat ");
  const interrupted = a["error.type"] === "GraphInterrupt";
  const label = str(a["bank.router.label"]);
  const confidence = num(a["bank.router.confidence"]);
  return {
    name: chat ? "chat" : s.name.replace(/^bank\.node\./, ""),
    kind: chat ? "chat" : "node",
    startedAt: s.started_at,
    durationMs: s.duration_ms,
    ruleIds: Array.isArray(a["bank.rule_ids"]) ? a["bank.rule_ids"].map(String) : [],
    decision: str(a["bank.gate.decision"]),
    router: label !== null && confidence !== null ? { label, confidence, name: str(a["bank.router.name"]) ?? "" } : null,
    model: str(a["gen_ai.request.model"]),
    inputTokens: num(a["gen_ai.usage.input_tokens"]),
    outputTokens: num(a["gen_ai.usage.output_tokens"]),
    costUsd: num(a["bank.cost_usd"]),
    // A confirmation pause is LangGraph's GraphInterrupt: expected control flow, not a failure.
    error: interrupted ? null : str(a["error.type"]),
    interrupted,
  };
}

/** Groups persisted spans (spec 8) into per-run turns for the trace view. Spans carry no message content. */
export function groupTrace(spans: SpanRecord[]): TraceTurn[] {
  const byTrace = new Map<string, SpanRecord[]>();
  for (const s of spans) byTrace.set(s.trace_id, [...(byTrace.get(s.trace_id) ?? []), s]);
  const turns = [...byTrace.entries()].map(([traceId, group]) => {
    // Start times have millisecond resolution: on a tie the enclosing (longer) node span comes before the chat
    // span it contains.
    const sorted = [...group].sort((x, y) => ms(x.started_at) - ms(y.started_at) || y.duration_ms - x.duration_ms);
    const steps = sorted.map(toStep);
    const start = Math.min(...sorted.map((s) => ms(s.started_at)));
    const end = Math.max(...sorted.map((s) => ms(s.started_at) + s.duration_ms));
    const chats = steps.filter((s) => s.kind === "chat");
    return {
      traceId,
      index: 0,
      startedAt: sorted[0]!.started_at,
      durationMs: Math.round(end - start),
      costUsd: chats.reduce((sum, s) => sum + (s.costUsd ?? 0), 0),
      llmCalls: chats.length,
      ruleIds: [...new Set(steps.flatMap((s) => s.ruleIds))],
      steps,
    };
  });
  turns.sort((x, y) => ms(x.startedAt) - ms(y.startedAt));
  return turns.map((t, i) => ({ ...t, index: i + 1 }));
}
