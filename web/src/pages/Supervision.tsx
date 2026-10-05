import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ApiError, type OpsMetrics, type OutcomeKind, api } from "../api";
import { BarList, Columns, Kpi } from "../components/Charts";
import { ConsoleMobileNav, ConsoleRail } from "../components/ConsoleRail";
import { RULE_TEXT } from "../rules";
import { type AgentSession, session } from "../session";

const OUTCOME_LABEL: Record<OutcomeKind, string> = {
  answered: "Respondida por Aida",
  dispute_created: "Disputa registrada",
  handoff: "Transferida a agente",
  clarify: "Pidió aclaración",
  abstain: "Fuera de alcance",
  greeting: "Saludo",
  cancelled: "Cancelada por el cliente",
};

const INTENT_LABEL: Record<string, string> = {
  check_balance: "Consultar saldo",
  list_transactions: "Ver movimientos",
  explain_charge: "Explicar un cargo",
  dispute_charge: "Disputar un cargo",
  request_human: "Pedir un humano",
  out_of_scope: "Fuera de alcance",
  greeting: "Saludo",
};

const WINDOWS = [
  [24, "24 h"],
  [168, "7 días"],
  [720, "30 días"],
] as const;

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const ms = (x: number | null) => (x === null ? "—" : x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`);

/** Live operations view for the support team: aggregates only, never conversation text. */
export function SupervisionPage() {
  const [agent, setAgent] = useState<AgentSession | null>(() => session.agent());
  const [hours, setHours] = useState<number>(168);
  const [m, setM] = useState<OpsMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState<Date | null>(null);

  useEffect(() => {
    if (!agent) return;
    const load = () =>
      api
        .metrics(agent.token, hours)
        .then((r) => {
          setM(r);
          setUpdated(new Date());
          setError(null);
        })
        .catch((e) => {
          if (e instanceof ApiError && e.status === 401) {
            session.setAgent(null);
            setAgent(null);
          } else setError("No se pudieron cargar las métricas.");
        });
    void load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [agent, hours]);

  if (!agent) {
    return (
      <main className="auth single">
        <div className="auth-form card">
          <p>Necesita una sesión de agente para ver la supervisión.</p>
          <Link to="/agent">Ingresar a la consola →</Link>
        </div>
      </main>
    );
  }

  const outcomeItems = m
    ? (Object.entries(m.outcomes) as [OutcomeKind, number][])
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => ({ label: OUTCOME_LABEL[k], value: n, display: String(n), detail: `${Math.round((n / Math.max(1, m.turns)) * 100)}% de los turnos` }))
    : [];

  return (
    <div className="console supervision">
      <ConsoleRail agent={agent} onLogout={() => setAgent(null)} />
      <ConsoleMobileNav agent={agent} onLogout={() => setAgent(null)} />
      <main className="page wide">
        <header className="page-head">
          <div>
            <h1>Supervisión</h1>
            <p className="muted">
              Operación del asistente en vivo{updated ? ` · actualizado ${updated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : ""}
            </p>
          </div>
          <div className="segmented" role="radiogroup" aria-label="Ventana de tiempo">
            {WINDOWS.map(([h, label]) => (
              <button key={h} type="button" role="radio" aria-checked={hours === h} className={hours === h ? "on" : ""} onClick={() => setHours(h)}>
                {label}
              </button>
            ))}
          </div>
        </header>

        {error && <p className="banner error">{error}</p>}
        {!m && !error && <p className="muted">Cargando…</p>}

        {m && (
          <>
            <div className="kpi-grid">
              <Kpi label="Resolución automática" value={pct(m.automatedResolutionRate)} hint="respondidas o disputas registradas, sin saludos" tone="good" />
              <Kpi label="Turnos" value={String(m.turns)} hint={`${m.sessions} sesiones de clientes`} />
              <Kpi label="Latencia p50 / p95" value={`${ms(m.latencyMs.p50)} / ${ms(m.latencyMs.p95)}`} hint="por turno, de punta a punta" />
              <Kpi label="Costo de IA" value={`USD ${m.llm.costUsd.toFixed(4)}`} hint={`${m.llm.calls} llamadas · ${m.llm.tokens.toLocaleString()} tokens`} />
              <Kpi label="Disputas registradas" value={String(m.disputes.count)} hint={`USD ${m.disputes.amountUsd.toFixed(2)} disputados`} />
              <Kpi
                label="Cola humana"
                value={String(m.queue.queued)}
                hint={`${m.queue.taken} en atención · ${m.queue.resolved} resueltos`}
                tone={m.queue.queued > 5 ? "warn" : undefined}
              />
            </div>

            <div className="grid-2">
              <section className="panel">
                <div className="panel-head">
                  <h2>Resultado de cada turno</h2>
                </div>
                <BarList caption="Resultado de cada turno" items={outcomeItems} empty="Todavía no hay turnos en esta ventana." />
              </section>
              <section className="panel">
                <div className="panel-head">
                  <h2>Por qué se transfirió a humanos</h2>
                </div>
                <BarList
                  caption="Escalamientos por regla"
                  empty="Sin transferencias en esta ventana."
                  items={m.escalationsByRule.slice(0, 8).map((r) => ({
                    label: r.ruleId,
                    value: r.count,
                    display: String(r.count),
                    detail: RULE_TEXT[r.ruleId] ?? "",
                  }))}
                />
              </section>
              <section className="panel">
                <div className="panel-head">
                  <h2>Intenciones detectadas</h2>
                  <span className="muted small">confianza media del router</span>
                </div>
                <BarList
                  caption="Intenciones detectadas"
                  items={m.intents.map((i) => ({
                    label: INTENT_LABEL[i.label] ?? i.label,
                    value: i.count,
                    display: `${i.count} · ${Math.round(i.avgConfidence * 100)}%`,
                    detail: `confianza media ${Math.round(i.avgConfidence * 100)}%`,
                  }))}
                />
              </section>
              <section className="panel">
                <div className="panel-head">
                  <h2>Señales de seguridad</h2>
                  <span className="muted small">detectadas y contenidas</span>
                </div>
                <BarList
                  caption="Señales de seguridad"
                  empty="Ninguna señal en esta ventana."
                  items={m.security.map((r) => ({ label: r.ruleId, value: r.count, display: String(r.count), detail: RULE_TEXT[r.ruleId] ?? "" }))}
                />
              </section>
            </div>

            <section className="panel">
              <div className="panel-head">
                <h2>Turnos por hora</h2>
                <span className="muted small">UTC</span>
              </div>
              <Columns
                caption="Turnos por hora"
                items={m.hourly.map((h) => ({
                  label: `${h.hour.slice(8, 10)}/${h.hour.slice(5, 7)} ${h.hour.slice(11, 13)}h`,
                  value: h.turns,
                  display: `${h.turns} turnos`,
                  detail: `${h.handoffs} transferidos`,
                }))}
              />
            </section>
          </>
        )}
      </main>
    </div>
  );
}
