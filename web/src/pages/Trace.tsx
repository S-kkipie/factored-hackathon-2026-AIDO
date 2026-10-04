import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ApiError, type Span, api } from "../api";
import { Wordmark } from "../components/Brand";
import { session } from "../session";

interface Turn {
  traceId: string;
  start: number;
  end: number;
  spans: Span[];
  ruleIds: string[];
  decision: string | null;
  costUsd: number;
  tokens: number;
}

const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${n.toFixed(0)} ms`);

function toTurns(spans: Span[]): Turn[] {
  const byTrace = new Map<string, Span[]>();
  for (const s of spans) byTrace.set(s.trace_id, [...(byTrace.get(s.trace_id) ?? []), s]);
  return [...byTrace.entries()]
    .map(([traceId, list]) => {
      const start = Math.min(...list.map((s) => Date.parse(s.started_at)));
      const end = Math.max(...list.map((s) => Date.parse(s.started_at) + s.duration_ms));
      const rules = new Set<string>();
      let decision: string | null = null;
      let costUsd = 0;
      let tokens = 0;
      for (const s of list) {
        const a = s.attributes;
        if (Array.isArray(a["bank.rule_ids"])) for (const r of a["bank.rule_ids"]) rules.add(r);
        if (typeof a["bank.gate.decision"] === "string") decision = a["bank.gate.decision"];
        if (typeof a["bank.cost_usd"] === "number") costUsd += a["bank.cost_usd"];
        tokens += Number(a["gen_ai.usage.input_tokens"] ?? 0) + Number(a["gen_ai.usage.output_tokens"] ?? 0);
      }
      return { traceId, start, end, spans: list.sort((x, y) => Date.parse(x.started_at) - Date.parse(y.started_at)), ruleIds: [...rules].sort(), decision, costUsd, tokens };
    })
    .sort((a, b) => a.start - b.start);
}

/** Per-turn timeline (spec 9): router, policy, tools, model calls, latency and cost. Content is never recorded. */
export function TracePage() {
  const { session: sessionId } = useParams({ from: "/trace/$session" });
  const [spans, setSpans] = useState<Span[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const customer = session.customer();
    const token = customer?.sessionId === sessionId ? customer.token : session.agent()?.token;
    if (!token) {
      setError("Necesitas la sesión del cliente o una sesión de agente para ver esta traza.");
      return;
    }
    const load = () =>
      api
        .trace(token, sessionId)
        .then(setSpans)
        .catch((e) => setError(e instanceof ApiError && e.status === 401 ? "La sesión expiró." : e instanceof ApiError && e.status === 403 ? "Sin permiso para esta sesión." : "No se pudo cargar la traza."));
    void load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [sessionId]);

  const turns = useMemo(() => toTurns(spans ?? []), [spans]);
  const totalCost = turns.reduce((s, t) => s + t.costUsd, 0);

  return (
    <div className="trace-layout">
      <header className="topbar">
        <div className="brand small">
          <Wordmark size={28} sub="Traza de sesión" />
          <span className="chip mono">{sessionId.slice(0, 8)}…</span>
          {spans && (
            <>
              <span className="chip">{turns.length} turnos</span>
              <span className="chip">{spans.length} spans</span>
              <span className="chip mono">USD {totalCost.toFixed(5)}</span>
            </>
          )}
        </div>
        <nav className="topbar-actions">
          <Link to="/chat" className="ghost">
            Chat
          </Link>
          <Link to="/agent" className="ghost">
            Agentes
          </Link>
        </nav>
      </header>

      <main className="trace-body">
        {error && <p className="error">{error}</p>}
        {!error && spans === null && <p className="muted">Cargando…</p>}
        {spans && turns.length === 0 && <p className="muted">Todavía no hay turnos en esta sesión.</p>}
        {turns.map((turn, i) => {
          const total = Math.max(1, turn.end - turn.start);
          return (
            <section key={turn.traceId} className="panel turn">
              <header className="turn-head">
                <h2>Turno {i + 1}</h2>
                <span className="muted small">{new Date(turn.start).toLocaleTimeString()}</span>
                <span className="chip mono">{ms(total)}</span>
                {turn.decision && <span className={`chip mono decision-${turn.decision}`}>{turn.decision}</span>}
                {turn.tokens > 0 && <span className="chip mono">{turn.tokens} tok · USD {turn.costUsd.toFixed(5)}</span>}
                {turn.ruleIds.map((r) => (
                  <span key={r} className="chip mono rule">
                    {r}
                  </span>
                ))}
              </header>
              <ol className="timeline">
                {turn.spans.map((s) => {
                  const left = ((Date.parse(s.started_at) - turn.start) / total) * 100;
                  const width = Math.max(0.8, (s.duration_ms / total) * 100);
                  const kind = s.name.startsWith("chat") ? "model" : s.name.startsWith("bank.node") ? "node" : "other";
                  const rules = s.attributes["bank.rule_ids"];
                  return (
                    <li key={s.span_id} className="span-row">
                      <span className="span-name mono small" title={s.name}>
                        {s.name.replace("bank.node.", "")}
                      </span>
                      <span className="span-track">
                        <span className={`span-bar ${kind}`} style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }} />
                      </span>
                      <span className="span-meta mono small">
                        {ms(s.duration_ms)}
                        {Array.isArray(rules) && rules.length > 0 ? ` · ${rules.join(", ")}` : ""}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </section>
          );
        })}
      </main>
    </div>
  );
}
