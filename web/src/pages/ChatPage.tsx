import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { useChat } from "../chat/useChat";
import { T, personaText, stepLabel } from "../lib/i18n";
import { clearCustomer, customerApi, readCustomer, type StoredCustomer } from "../session";

export function ChatPage() {
  const session = readCustomer();
  if (!session) return null;
  return <Chat session={session} />;
}

function Chat({ session }: { session: StoredCustomer }) {
  const navigate = useNavigate();
  const t = T[session.language];
  const onExpired = useCallback(() => {
    clearCustomer();
    void navigate({ to: "/login", search: { expired: true } });
  }, [navigate]);
  const { state, send, answer } = useChat(session, onExpired);
  const [draft, setDraft] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [state.lines.length, state.pending, state.running]);

  async function logout() {
    try {
      await customerApi.logout();
    } catch {
      // Logging out locally is enough when the server session is already gone.
    }
    clearCustomer();
    await navigate({ to: "/login" });
  }

  function submit(e?: FormEvent) {
    e?.preventDefault();
    const text = draft;
    setDraft("");
    void send(text);
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  const locked = state.running || state.pending !== null;
  const who = { user: t.you, assistant: t.assistant, agent: t.agent, system: "" } as const;
  const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString(session.language, { hour: "2-digit", minute: "2-digit" }) : "");

  return (
    <section className="chat" aria-label="Chat">
      <div className="chat-head">
        <div>
          <strong>{personaText(session.persona, session.language).name}</strong>
          <span className="muted"> · {session.language.toUpperCase()}</span>
        </div>
        <div className="row">
          <Link to="/trace/$session" params={{ session: session.sessionId }} target="_blank">
            {t.viewTrace}
          </Link>
          <button type="button" onClick={logout}>
            {t.logout}
          </button>
        </div>
      </div>

      <div>
        {state.caseId && (
          <div className="banner ok" role="status">
            {t.caseCreated}: <span className="mono">{state.caseId}</span>
          </div>
        )}
        {state.handedOff && (
          <div className="banner warn" role="status">
            {t.handedOff}
            {state.handoffId && <span className="mono"> ({state.handoffId})</span>}
          </div>
        )}
      </div>

      <div className="chat-log" ref={logRef} aria-live="polite">
        {state.lines.length === 0 && <p className="muted">{t.empty}</p>}
        {state.lines.map((l) => (
          <div key={l.id} className={`bubble ${l.author}`}>
            {who[l.author] && <span className="who">{who[l.author]}</span>}
            {l.text}
          </div>
        ))}

        {state.pending && (
          <div className="confirm-card" role="group" aria-label={t.confirmTitle}>
            <h3>{t.confirmTitle}</h3>
            <div className="bubble assistant">{state.pending.message}</div>
            {state.pending.expiresAt && (
              <small className="muted">
                {t.expiresAt} {time(state.pending.expiresAt)}
              </small>
            )}
            <div className="actions">
              <button type="button" className="primary" onClick={() => void answer(true)}>
                {t.confirm}
              </button>
              <button type="button" onClick={() => void answer(false)}>
                {t.cancel}
              </button>
            </div>
          </div>
        )}

        {state.running && (
          <div className="status" role="status">
            <span className="dot" aria-hidden="true" />
            {stepLabel(state.step, session.language)}
            {state.route && (
              <span className="chip">
                {state.route.label} · {t.confidence} {state.route.confidence.toFixed(2)}
              </span>
            )}
            {state.decision && <span className="chip">{state.decision.action}</span>}
          </div>
        )}
        {!state.running && state.ruleIds.length > 0 && (
          <div className="chips" aria-label={t.rules}>
            {state.ruleIds.map((r) => (
              <span key={r} className="chip mono">
                {r}
              </span>
            ))}
          </div>
        )}
        {state.error && <p className="notice error">{state.error}</p>}
      </div>

      <form className="composer" onSubmit={submit}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          placeholder={t.placeholder}
          maxLength={2000}
          rows={1}
          disabled={locked}
          aria-label={t.placeholder}
        />
        <button type="submit" className="primary" disabled={locked || draft.trim().length === 0}>
          {t.send}
        </button>
      </form>
    </section>
  );
}
