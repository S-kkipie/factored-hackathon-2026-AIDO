import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import { ruleText } from "../lib/rules-text";
import { type TraceTurn, groupTrace } from "../lib/trace";
import { traceRoute } from "../router";
import { agentApi, customerApi, readAgent } from "../session";

const usd = (n: number) => `$${n.toFixed(n < 0.01 ? 6 : 4)}`;

export function TracePage() {
  const { session } = traceRoute.useParams();
  const [turns, setTurns] = useState<TraceTurn[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    // An agent may read any session's trace; a customer only their own (enforced by the server).
    const api = readAgent() ? agentApi : customerApi;
    try {
      setTurns(groupTrace(await api.trace(session)));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError && (e.status === 401 || e.status === 403) ? "Sin acceso a esta traza. Inicia sesión como agente o como el cliente de esta sesión." : "No se pudo cargar la traza.");
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  const total = (turns ?? []).reduce((a, t) => ({ cost: a.cost + t.costUsd, calls: a.calls + t.llmCalls }), { cost: 0, calls: 0 });

  return (
    <section>
      <div className="toolbar">
        <div>
          <h1>Traza de la sesión</h1>
          <p className="muted mono">{session}</p>
        </div>
        <button type="button" onClick={() => void load()}>
          Actualizar
        </button>
      </div>
      {error && <p className="notice error">{error}</p>}
      {turns && (
        <div className="summary">
          <div className="stat">
            <b>{turns.length}</b>
            <span className="muted">turnos</span>
          </div>
          <div className="stat">
            <b>{total.calls}</b>
            <span className="muted">llamadas LLM</span>
          </div>
          <div className="stat">
            <b>{usd(total.cost)}</b>
            <span className="muted">costo LLM</span>
          </div>
        </div>
      )}
      {turns?.length === 0 && <p className="muted">Esta sesión aún no tiene turnos.</p>}
      {turns?.map((t) => (
        <article key={t.traceId} className="panel turn">
          <div className="turn-head">
            <h3>Turno {t.index}</h3>
            <span className="muted">
              {new Date(t.startedAt).toLocaleTimeString("es")} · {t.durationMs} ms · {t.llmCalls} LLM · {usd(t.costUsd)}
            </span>
          </div>
          <div className="steps">
            {t.steps.map((s, i) => (
              <div key={i} className={`step ${s.kind}`}>
                <span className="mono">{s.kind === "chat" ? `↳ ${s.model ?? "chat"}` : s.name}</span>
                <span className="bar" style={{ width: `${Math.max(1, Math.round((s.durationMs / Math.max(1, t.durationMs)) * 100))}%` }} />
                <span className="ms">{Math.round(s.durationMs)} ms</span>
                {(s.router || s.decision || s.ruleIds.length > 0 || s.costUsd !== null || s.error) && (
                  <div className="step-detail chips">
                    {s.router && (
                      <span className="chip">
                        {s.router.label} · {s.router.confidence.toFixed(2)} · {s.router.name}
                      </span>
                    )}
                    {s.decision && <span className="chip warn">{s.decision}</span>}
                    {s.ruleIds.map((r) => (
                      <span key={r} className="chip mono" title={ruleText(r)}>
                        {r}
                      </span>
                    ))}
                    {s.costUsd !== null && (
                      <span className="chip">
                        {s.inputTokens ?? 0} in / {s.outputTokens ?? 0} out · {usd(s.costUsd)}
                      </span>
                    )}
                    {s.error && <span className="chip danger">{s.error}</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </article>
      ))}
    </section>
  );
}
