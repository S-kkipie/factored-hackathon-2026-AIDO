import { Link } from "@tanstack/react-router";
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, type ChatMessage, type QueueItem, api } from "../api";
import { Avatar, Wordmark } from "../components/Brand";
import { ConsoleRail } from "../components/ConsoleRail";
import { ago } from "../format";
import { PRIORITY_RANK, type Priority, RULE_TEXT, priorityOf } from "../rules";
import { type AgentSession, session } from "../session";

type Filter = "all" | "queued" | "mine";

const QUICK_REPLIES = [
  "Hola, soy del equipo de AIDO y ya revisé su caso.",
  "¿Puede confirmarme si reconoce el comercio y la fecha del cargo?",
  "Por seguridad, bloqueamos preventivamente su tarjeta. Le enviaremos una nueva.",
  "Su caso quedó registrado. Le escribiremos por este medio con la resolución.",
];

const PRIORITY_LABEL: Record<Priority, string> = { alta: "Prioridad alta", media: "Prioridad media", normal: "Normal" };

/** Handoff queue and case view. Card strings are rendered as text only, never as HTML. */
export function AgentPage() {
  const [agent, setAgent] = useState<AgentSession | null>(() => session.agent());
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [toast, setToast] = useState<string | null>(null);
  const known = useRef<Set<string> | null>(null);
  const thread = useRef<HTMLDivElement>(null);

  const onAuthError = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) {
      session.setAgent(null);
      setAgent(null);
      setError("Su sesión de agente expiró. Ingrese de nuevo.");
      return true;
    }
    return false;
  }, []);

  const loadQueue = useCallback(async () => {
    if (!agent) return;
    try {
      const q = await api.queue(agent.token);
      // New-case alert: anything not seen in the previous poll (the first poll only primes the set).
      const ids = new Set(q.map((i) => i.handoffId));
      if (known.current) {
        const fresh = q.filter((i) => !known.current!.has(i.handoffId));
        if (fresh.length > 0) {
          const urgent = fresh.some((i) => priorityOf(i.ruleIds) === "alta");
          setToast(`${fresh.length === 1 ? "Nuevo caso" : `${fresh.length} casos nuevos`}${urgent ? " · prioridad alta" : ""}`);
        }
      }
      known.current = ids;
      setQueue(q);
    } catch (e) {
      onAuthError(e);
    }
  }, [agent, onAuthError]);

  const loadMessages = useCallback(async () => {
    if (!agent || !selected) return;
    try {
      setMessages(await api.sessionMessages(agent.token, selected));
    } catch (e) {
      onAuthError(e);
    }
  }, [agent, selected, onAuthError]);

  useEffect(() => {
    void loadQueue();
    const timer = setInterval(loadQueue, 4000);
    return () => clearInterval(timer);
  }, [loadQueue]);

  useEffect(() => {
    setMessages([]);
    void loadMessages();
    const timer = setInterval(loadMessages, 3000);
    return () => clearInterval(timer);
  }, [loadMessages]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    thread.current?.scrollTo({ top: thread.current.scrollHeight });
  }, [messages]);

  const waiting = queue.filter((q) => q.status === "queued").length;
  useEffect(() => {
    document.title = waiting > 0 ? `(${waiting}) Consola · AIDO` : "Consola · AIDO";
    return () => {
      document.title = "AIDO";
    };
  }, [waiting]);

  const visible = useMemo(() => {
    const mine = (q: QueueItem) => q.status === "taken" && q.takenBy === agent?.sessionId;
    return queue
      .filter((q) => (filter === "all" ? true : filter === "queued" ? q.status === "queued" : mine(q)))
      .sort((a, b) => PRIORITY_RANK[priorityOf(a.ruleIds)] - PRIORITY_RANK[priorityOf(b.ruleIds)] || a.createdAt.localeCompare(b.createdAt));
  }, [queue, filter, agent]);

  async function login(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api.agentLogin(pin);
      const s = { token: r.token, sessionId: r.sessionId, expiresAt: r.expiresAt };
      session.setAgent(s);
      setAgent(s);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "PIN incorrecto." : "No pudimos conectar con el servidor.");
    }
  }

  async function act(fn: () => Promise<{ ok: boolean }>, conflict: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (!r.ok) setError(conflict);
    } catch (e) {
      if (!onAuthError(e)) setError(e instanceof ApiError && e.status === 409 ? conflict : "La operación falló. Inténtelo de nuevo.");
    } finally {
      setBusy(false);
      await Promise.all([loadQueue(), loadMessages()]);
    }
  }

  if (!agent) {
    return (
      <main className="auth single">
        <form onSubmit={login} className="auth-form card">
          <Wordmark size={36} sub="Consola de agentes" />
          <p className="muted">Casos que Aida transfirió a un humano, con el contexto ya verificado.</p>
          <label className="field">
            <span>PIN de agente</span>
            <input value={pin} onChange={(e) => setPin(e.target.value)} type="password" inputMode="numeric" maxLength={12} autoComplete="off" />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="primary big" type="submit">
            Ingresar
          </button>
          <div className="auth-foot">
            <Link to="/login">← Acceso de clientes</Link>
          </div>
        </form>
      </main>
    );
  }

  const item = queue.find((q) => q.sessionId === selected) ?? null;
  const mine = item?.status === "taken" && item.takenBy === agent.sessionId;
  const takenByOther = item?.status === "taken" && !mine;

  const sendReply = () => {
    const text = reply.trim();
    if (!text || !item || !mine) return;
    setReply("");
    void act(() => api.reply(agent.token, item.sessionId, text), "Tome el caso antes de responder.");
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendReply();
    }
  };

  return (
    <div className="console">
      <ConsoleRail agent={agent} onLogout={() => setAgent(null)}>
        <div className="rail-stats">
          <div>
            <span className="stat-num">{waiting}</span>
            <span className="muted small">en espera</span>
          </div>
          <div>
            <span className="stat-num">{queue.filter((q) => q.takenBy === agent.sessionId).length}</span>
            <span className="muted small">míos</span>
          </div>
          <div>
            <span className="stat-num danger">{queue.filter((q) => priorityOf(q.ruleIds) === "alta").length}</span>
            <span className="muted small">alta</span>
          </div>
        </div>
      </ConsoleRail>

      <section className="queue-col" aria-label="Cola de casos">
        <header className="queue-head">
          <h2>Casos</h2>
          <div className="segmented small" role="tablist">
            {(
              [
                ["all", "Todos"],
                ["queued", "En cola"],
                ["mine", "Míos"],
              ] as const
            ).map(([f, label]) => (
              <button key={f} type="button" role="tab" aria-selected={filter === f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                {label}
              </button>
            ))}
          </div>
        </header>
        <div className="queue-list">
          {visible.length === 0 && <p className="muted pad small">No hay casos en esta vista.</p>}
          {visible.map((q) => {
            const p = priorityOf(q.ruleIds);
            return (
              <button key={q.handoffId} type="button" className={`queue-item${q.sessionId === selected ? " active" : ""}`} onClick={() => setSelected(q.sessionId)}>
                <span className={`prio-bar ${p}`} aria-hidden="true" />
                <span className="queue-main">
                  <span className="queue-top">
                    <span className="queue-summary">{RULE_TEXT[q.ruleIds[0] ?? ""] ?? q.card.summary}</span>
                    <span className="muted small nowrap">{ago(q.createdAt, now)}</span>
                  </span>
                  <span className="queue-meta">
                    <span className={`pill prio-${p}`}>{PRIORITY_LABEL[p]}</span>
                    <span className="pill">{q.card.language.toUpperCase()}</span>
                    {q.status === "taken" && <span className="pill taken">{q.takenBy === agent.sessionId ? "Tuyo" : "Tomado"}</span>}
                    <span className="mono small muted">{q.handoffId}</span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="case-col">
        {!item ? (
          <div className="case-empty">
            <svg viewBox="0 0 24 24" width="40" height="40" aria-hidden="true">
              <path d="M4 5h16v11H8l-4 4z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
            <p>Seleccione un caso para ver el contexto y conversar con el cliente.</p>
          </div>
        ) : (
          <>
            <header className="case-head">
              <div>
                <div className="row">
                  <h2 className="mono">{item.handoffId}</h2>
                  <span className={`pill prio-${priorityOf(item.ruleIds)}`}>{PRIORITY_LABEL[priorityOf(item.ruleIds)]}</span>
                </div>
                <p className="muted small">
                  Recibido {ago(item.createdAt, now)} · Idioma {item.card.language.toUpperCase()}
                </p>
              </div>
              <div className="row">
                <Link to="/trace/$session" params={{ session: item.sessionId }} target="_blank" className="ghost">
                  Ver traza
                </Link>
                {!mine && (
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || takenByOther}
                    onClick={() => act(() => api.take(agent.token, item.sessionId), "Otro agente ya tomó este caso.")}
                  >
                    {takenByOther ? "Tomado por otro agente" : "Tomar caso"}
                  </button>
                )}
                {mine && (
                  <button type="button" className="secondary" disabled={busy} onClick={() => act(() => api.resolve(agent.token, item.sessionId), "No se pudo cerrar el caso.")}>
                    Resolver y devolver a Aida
                  </button>
                )}
              </div>
            </header>

            <div className="case-body">
              <div className="conversation">
                <div className="thread" ref={thread}>
                  <div className="thread-note">
                    Aida transfirió esta conversación. El cliente verá sus respuestas en su chat.
                  </div>
                  {messages.length === 0 && <p className="muted small center">El cliente aún no escribió después del traspaso.</p>}
                  {messages.map((m) => (
                    <div key={m.id} className={`msg ${m.author === "agent" ? "user" : "assistant"}`}>
                      {m.author === "customer" && (
                        <span className="avatar customer" aria-hidden="true">
                          C
                        </span>
                      )}
                      <div className="msg-body">
                        <div className="bubble">
                          <p>{m.text}</p>
                        </div>
                        <span className="msg-time">{new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                      </div>
                      {m.author === "agent" && <Avatar who="agent" />}
                    </div>
                  ))}
                </div>
                {mine && (
                  <div className="quick-replies">
                    {QUICK_REPLIES.map((q) => (
                      <button key={q} type="button" className="chip-btn" onClick={() => setReply(q)}>
                        {q.length > 42 ? `${q.slice(0, 40)}…` : q}
                      </button>
                    ))}
                  </div>
                )}
                <form
                  className="composer"
                  onSubmit={(e) => {
                    e.preventDefault();
                    sendReply();
                  }}
                >
                  <textarea
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    onKeyDown={onKey}
                    rows={1}
                    placeholder={mine ? "Responder al cliente…" : "Tome el caso para responder"}
                    maxLength={500}
                    disabled={!mine}
                  />
                  <button className="send" type="submit" disabled={!mine || busy || !reply.trim()} aria-label="Enviar">
                    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                      <path d="M4 12 20 4l-6 16-3-6.5z" fill="currentColor" />
                    </svg>
                  </button>
                </form>
              </div>

              <aside className="case-card">
                <section>
                  <h3>Resumen</h3>
                  <p>{item.card.summary}</p>
                </section>
                <section>
                  <h3>Por qué se transfirió</h3>
                  <ul className="rule-list">
                    {item.card.ruleIds.map((r) => (
                      <li key={r}>
                        <span className="mono small rule-id">{r}</span>
                        <span>{RULE_TEXT[r] ?? "—"}</span>
                      </li>
                    ))}
                  </ul>
                </section>
                <section>
                  <h3>Hechos verificados</h3>
                  {item.card.verifiedFacts.length === 0 ? (
                    <p className="muted small">Sin movimientos identificados.</p>
                  ) : (
                    <ul className="facts">
                      {item.card.verifiedFacts.map((f) => (
                        <li key={f.id}>
                          <span className="mono small">{f.id}</span>
                          <span>{f.detail}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                {item.card.actionsTaken.length > 0 && (
                  <section>
                    <h3>Acciones ya realizadas</h3>
                    <ul>
                      {item.card.actionsTaken.map((a) => (
                        <li key={a}>{a}</li>
                      ))}
                    </ul>
                  </section>
                )}
                {item.card.openQuestions.length > 0 && (
                  <section>
                    <h3>Preguntas abiertas</h3>
                    <ul>
                      {item.card.openQuestions.map((q) => (
                        <li key={q}>{q}</li>
                      ))}
                    </ul>
                  </section>
                )}
              </aside>
            </div>
          </>
        )}
        {error && (
          <p className="banner error" role="alert">
            {error}
          </p>
        )}
      </section>

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
