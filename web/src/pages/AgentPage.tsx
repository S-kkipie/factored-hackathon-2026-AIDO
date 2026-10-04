import { Link } from "@tanstack/react-router";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { HandoffCardView } from "../agent/HandoffCardView";
import { Wordmark } from "../Brand";
import { ApiError, type ChatMessage, type QueueItem } from "../lib/api";
import { agentApi, clearAgent, readAgent, writeAgent } from "../session";

const QUEUE_MS = 4000;
const THREAD_MS = 3000;

export function AgentPage() {
  const [signedIn, setSignedIn] = useState(() => readAgent() !== null);
  const signOut = useCallback(() => {
    clearAgent();
    setSignedIn(false);
  }, []);
  return signedIn ? <Console onSignOut={signOut} /> : <AgentLogin onDone={() => setSignedIn(true)} />;
}

function AgentLogin({ onDone }: { onDone: () => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await agentApi.agentLogin(pin);
      writeAgent({ token: r.token, sessionId: r.sessionId, expiresAt: r.expiresAt });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "PIN de agente incorrecto." : "No se pudo iniciar sesión.");
    }
  }
  return (
    <main className="auth single">
      <form onSubmit={submit} className="auth-form card">
        <Wordmark size={36} sub="Consola de agentes" />
        <p className="muted">Casos derivados por el asistente, con contexto estructurado.</p>
        <label className="field">
          <span>PIN de agente</span>
          <input inputMode="numeric" autoComplete="off" maxLength={12} value={pin} onChange={(e) => setPin(e.target.value)} required />
          <small className="muted">PIN de demostración: 1357</small>
        </label>
        {error && <p className="notice error">{error}</p>}
        <button type="submit" className="primary big" disabled={pin.length === 0}>
          Entrar
        </button>
      </form>
    </main>
  );
}

function Console({ onSignOut }: { onSignOut: () => void }) {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const me = readAgent()?.sessionId ?? null;

  const guard = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) onSignOut();
      else setError("No se pudo completar la acción.");
    },
    [onSignOut],
  );

  const refresh = useCallback(async () => {
    try {
      setQueue(await agentApi.queue());
    } catch (e) {
      guard(e);
    }
  }, [guard]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, QUEUE_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const item = queue.find((q) => q.sessionId === selected) ?? null;

  async function logout() {
    try {
      await agentApi.logout();
    } catch {
      // Already signed out on the server.
    }
    onSignOut();
  }

  return (
    <section>
      <div className="toolbar">
        <h1>Consola de agentes</h1>
        <button type="button" onClick={logout}>
          Salir
        </button>
      </div>
      {error && <p className="notice error">{error}</p>}
      <div className="console">
        <div className="queue" aria-label="Cola de casos">
          {queue.length === 0 && <p className="muted">No hay casos en cola.</p>}
          {queue.map((q) => (
            <button
              key={q.handoffId}
              type="button"
              className={`queue-item${q.sessionId === selected ? " selected" : ""}`}
              onClick={() => setSelected(q.sessionId)}
            >
              <span className="row">
                <span className={`chip ${q.status === "taken" ? "ok" : "warn"}`}>{q.status === "taken" ? "Tomado" : "En cola"}</span>
                <span className="muted">{new Date(q.createdAt).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}</span>
              </span>
              <span>{q.card.summary}</span>
              <span className="chips">
                {q.ruleIds.map((r) => (
                  <span key={r} className="chip mono">
                    {r}
                  </span>
                ))}
              </span>
            </button>
          ))}
        </div>
        <div className="panel">
          {item ? (
            <CaseDetail key={item.handoffId} item={item} mine={item.takenBy === me} onChange={refresh} onError={guard} />
          ) : (
            <p className="muted">Selecciona un caso de la cola.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function CaseDetail({
  item,
  mine,
  onChange,
  onError,
}: {
  item: QueueItem;
  mine: boolean;
  onChange: () => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const takenByOther = item.status === "taken" && !mine;

  const load = useCallback(async () => {
    try {
      setMessages(await agentApi.sessionMessages(item.sessionId));
    } catch (e) {
      onError(e);
    }
  }, [item.sessionId, onError]);

  useEffect(() => {
    void load();
    const timer = setInterval(load, THREAD_MS);
    return () => clearInterval(timer);
  }, [load]);

  async function act(fn: () => Promise<unknown>, done: string) {
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      await onChange();
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setNotice("Otro agente tiene este caso o ya no está abierto.");
      else onError(e);
    }
  }

  async function sendReply(e: FormEvent) {
    e.preventDefault();
    const clean = text.trim();
    if (!clean) return;
    setText("");
    await act(() => agentApi.reply(item.sessionId, clean), "Respuesta enviada.");
  }

  return (
    <div>
      <div className="toolbar">
        <h2>Caso derivado</h2>
        <Link to="/trace/$session" params={{ session: item.sessionId }} target="_blank" rel="opener">
          Ver traza
        </Link>
      </div>
      <HandoffCardView card={item.card} />

      <div className="card-section">
        <h4>Conversación con el cliente</h4>
        <div className="thread">
          {messages.length === 0 && <p className="muted">Sin mensajes desde la derivación.</p>}
          {messages.map((m) => (
            <div key={m.id} className={`bubble ${m.author === "agent" ? "user" : "assistant"}`}>
              <span className="who">{m.author === "agent" ? "Agente" : "Cliente"}</span>
              {m.text}
            </div>
          ))}
        </div>
      </div>

      {notice && <p className="notice">{notice}</p>}
      {item.status === "queued" && (
        <button type="button" className="primary" onClick={() => act(() => agentApi.take(item.sessionId), "Caso tomado.")}>
          Tomar caso
        </button>
      )}
      {takenByOther && <p className="muted">Otro agente atiende este caso.</p>}
      {mine && (
        <>
          <form className="reply" onSubmit={sendReply}>
            <input value={text} onChange={(e) => setText(e.target.value)} maxLength={500} placeholder="Escribe al cliente…" aria-label="Respuesta" />
            <button type="submit" className="primary" disabled={text.trim().length === 0}>
              Enviar
            </button>
          </form>
          <p>
            <button type="button" onClick={() => act(() => agentApi.resolve(item.sessionId), "Caso cerrado; el asistente retoma la conversación.")}>
              Cerrar y devolver al asistente
            </button>
          </p>
        </>
      )}
    </div>
  );
}
