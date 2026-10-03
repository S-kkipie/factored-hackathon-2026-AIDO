import { Link } from "@tanstack/react-router";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { ApiError, type ChatMessage, type QueueItem, api } from "../api";
import { type AgentSession, session } from "../session";

/** Handoff queue and case view (spec 9). Card strings are rendered as text only, never as HTML. */
export function AgentPage() {
  const [agent, setAgent] = useState<AgentSession | null>(() => session.agent());
  const [pin, setPin] = useState("1357");
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);

  const onAuthError = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) {
      session.setAgent(null);
      setAgent(null);
      setError("La sesión de agente expiró. Vuelve a entrar.");
      return true;
    }
    return false;
  }, []);

  const loadQueue = useCallback(async () => {
    if (!agent) return;
    try {
      setQueue(await api.queue(agent.token));
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
    void loadMessages();
    const timer = setInterval(loadMessages, 3000);
    return () => clearInterval(timer);
  }, [loadMessages]);

  async function login(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api.agentLogin(pin);
      const s = { token: r.token, sessionId: r.sessionId, expiresAt: r.expiresAt };
      session.setAgent(s);
      setAgent(s);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "PIN inválido." : "No se pudo conectar con el servidor.");
    }
  }

  async function act(fn: () => Promise<{ ok: boolean }>, conflict: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (!r.ok) setError(conflict);
    } catch (e) {
      if (!onAuthError(e)) setError(e instanceof ApiError && e.status === 409 ? conflict : "La operación falló.");
    } finally {
      setBusy(false);
      await Promise.all([loadQueue(), loadMessages()]);
    }
  }

  if (!agent) {
    return (
      <main className="login">
        <section className="login-card narrow">
          <h1>Consola de agentes</h1>
          <p className="muted">Casos transferidos por el asistente, con contexto estructurado.</p>
          <form onSubmit={login} className="stack">
            <label className="field">
              <span>PIN de agente</span>
              <input value={pin} onChange={(e) => setPin(e.target.value)} inputMode="numeric" maxLength={12} autoComplete="off" />
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button className="primary" type="submit">
              Entrar
            </button>
          </form>
          <footer className="login-footer">
            <Link to="/login">← Chat de clientes</Link>
          </footer>
        </section>
      </main>
    );
  }

  const item = queue.find((q) => q.sessionId === selected) ?? null;
  const mine = item?.status === "taken" && item.takenBy === agent.sessionId;

  return (
    <div className="agent-layout">
      <header className="topbar">
        <div className="brand small">
          <strong>Consola de agentes</strong>
          <span className="chip">{queue.length} en cola</span>
        </div>
        <nav className="topbar-actions">
          <button
            type="button"
            className="ghost"
            onClick={async () => {
              await api.logout(agent.token).catch(() => {});
              session.setAgent(null);
              setAgent(null);
            }}
          >
            Salir
          </button>
        </nav>
      </header>

      <div className="agent-body">
        <aside className="queue" aria-label="Cola de casos">
          {queue.length === 0 && <p className="muted pad">No hay casos en cola.</p>}
          {queue.map((q) => (
            <button
              key={q.handoffId}
              type="button"
              className={`queue-item${q.sessionId === selected ? " active" : ""}`}
              onClick={() => setSelected(q.sessionId)}
            >
              <span className="queue-top">
                <span className="mono small">{q.handoffId}</span>
                <span className={`chip ${q.status === "taken" ? "taken" : ""}`}>{q.status === "taken" ? (q.takenBy === agent.sessionId ? "tuyo" : "tomado") : "en cola"}</span>
              </span>
              <span className="queue-rules">
                {q.ruleIds.slice(0, 3).map((r) => (
                  <span key={r} className="chip mono rule">
                    {r}
                  </span>
                ))}
              </span>
              <span className="muted small">
                {new Date(q.createdAt).toLocaleString()} · {q.card.language.toUpperCase()}
              </span>
            </button>
          ))}
        </aside>

        <section className="case">
          {!item ? (
            <p className="muted pad">Selecciona un caso de la cola.</p>
          ) : (
            <>
              <div className="case-head">
                <div>
                  <h2 className="mono">{item.handoffId}</h2>
                  <p className="muted small">Sesión {item.sessionId}</p>
                </div>
                <div className="row">
                  <Link to="/trace/$session" params={{ session: item.sessionId }} target="_blank" className="ghost">
                    Traza
                  </Link>
                  {!mine && (
                    <button type="button" className="primary" disabled={busy} onClick={() => act(() => api.take(agent.token, item.sessionId), "Otro agente ya tomó este caso.")}>
                      Tomar caso
                    </button>
                  )}
                  {mine && (
                    <button type="button" className="secondary" disabled={busy} onClick={() => act(() => api.resolve(agent.token, item.sessionId), "No se pudo cerrar el caso.")}>
                      Resolver y devolver al asistente
                    </button>
                  )}
                </div>
              </div>

              <div className="card-grid">
                <div className="panel">
                  <h3>Resumen</h3>
                  <p>{item.card.summary}</p>
                  <h3>Reglas</h3>
                  <div className="queue-rules">
                    {item.card.ruleIds.map((r) => (
                      <span key={r} className="chip mono rule">
                        {r}
                      </span>
                    ))}
                  </div>
                  {item.card.actionsTaken.length > 0 && (
                    <>
                      <h3>Acciones tomadas</h3>
                      <ul>
                        {item.card.actionsTaken.map((a) => (
                          <li key={a}>{a}</li>
                        ))}
                      </ul>
                    </>
                  )}
                  {item.card.openQuestions.length > 0 && (
                    <>
                      <h3>Preguntas abiertas</h3>
                      <ul>
                        {item.card.openQuestions.map((q) => (
                          <li key={q}>{q}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
                <div className="panel">
                  <h3>Hechos verificados</h3>
                  {item.card.verifiedFacts.length === 0 ? (
                    <p className="muted small">Sin transacciones identificadas.</p>
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
                </div>
              </div>

              <div className="panel">
                <h3>Conversación con el cliente</h3>
                <div className="thread">
                  {messages.length === 0 && <p className="muted small">El cliente aún no escribió después del traspaso.</p>}
                  {messages.map((m) => (
                    <div key={m.id} className={`bubble ${m.author === "agent" ? "user" : "assistant"}`}>
                      <span className="bubble-label">{m.author === "agent" ? "Tú (agente)" : "Cliente"}</span>
                      <p>{m.text}</p>
                    </div>
                  ))}
                </div>
                <form
                  className="composer"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const text = reply.trim();
                    if (!text) return;
                    setReply("");
                    void act(() => api.reply(agent.token, item.sessionId, text), "Toma el caso antes de responder.");
                  }}
                >
                  <input value={reply} onChange={(e) => setReply(e.target.value)} placeholder={mine ? "Responder al cliente…" : "Toma el caso para responder"} maxLength={500} disabled={!mine} />
                  <button className="primary" type="submit" disabled={!mine || busy || !reply.trim()}>
                    Enviar
                  </button>
                </form>
              </div>
            </>
          )}
          {error && (
            <p className="error pad" role="alert">
              {error}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
