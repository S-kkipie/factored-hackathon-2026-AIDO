import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type Interrupt, api, runAgent } from "../api";
import { strings } from "../i18n";
import { session } from "../session";

interface Line {
  id: string;
  who: "user" | "assistant" | "agent" | "system";
  text: string;
}

interface Status {
  step: string | null;
  route: { label: string; confidence: number } | null;
  decision: { action: string; ruleIds: string[] } | null;
  outcome: string | null;
  ruleIds: string[];
}

const EMPTY_STATUS: Status = { step: null, route: null, decision: null, outcome: null, ruleIds: [] };

export function ChatPage() {
  const navigate = useNavigate();
  const [s] = useState(() => session.customer());
  const t = strings[s?.language ?? "es"];
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(EMPTY_STATUS);
  const [pending, setPending] = useState<Interrupt | null>(null);
  const [handedOff, setHandedOff] = useState(false);
  const [expired, setExpired] = useState(false);
  const lastAgentId = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);

  const push = useCallback((line: Omit<Line, "id">) => setLines((ls) => [...ls, { ...line, id: crypto.randomUUID() }]), []);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [lines, pending, status.step]);

  // While a human holds the case, their replies arrive over a plain poll (the agent console is REST, spec 9).
  useEffect(() => {
    if (!handedOff || !s) return;
    const tick = async () => {
      try {
        const msgs = await api.agentMessages(s.token, lastAgentId.current);
        for (const m of msgs) {
          lastAgentId.current = Math.max(lastAgentId.current, m.id);
          push({ who: "agent", text: m.text });
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) setExpired(true);
      }
    };
    void tick();
    const timer = setInterval(tick, 3000);
    return () => clearInterval(timer);
  }, [handedOff, s, push]);

  if (!s) return null;

  async function drive(body: Parameters<typeof runAgent>[2]) {
    if (!s) return;
    setBusy(true);
    setStatus(EMPTY_STATUS);
    try {
      for await (const e of runAgent(s.token, s.sessionId, body)) {
        switch (e.type) {
          case "STEP_STARTED":
            setStatus((st) => ({ ...st, step: String(e.stepName) }));
            break;
          case "STATE_DELTA":
            for (const op of e.delta as { path: string; value: unknown }[]) {
              setStatus((st) => {
                if (op.path === "/route") return { ...st, route: op.value as Status["route"] };
                if (op.path === "/decision") return { ...st, decision: op.value as Status["decision"] };
                if (op.path === "/outcome") return { ...st, outcome: String(op.value) };
                if (op.path === "/ruleIds") return { ...st, ruleIds: op.value as string[] };
                return st;
              });
              if (op.path === "/outcome" && (op.value === "handoff" || op.value === "handed_off")) setHandedOff(true);
            }
            break;
          case "TEXT_MESSAGE_CONTENT":
            push({ who: "assistant", text: String(e.delta) });
            break;
          case "RUN_FINISHED": {
            const outcome = e.outcome as { type: string; interrupts?: Interrupt[] };
            setPending(outcome.type === "interrupt" ? (outcome.interrupts?.[0] ?? null) : null);
            break;
          }
          case "RUN_ERROR":
            push({ who: "system", text: t.runError });
            break;
        }
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setExpired(true);
      else push({ who: "system", text: t.runError });
    } finally {
      setBusy(false);
      setStatus((st) => ({ ...st, step: null }));
    }
  }

  async function send(text: string) {
    const clean = text.trim();
    if (!clean || busy) return;
    setInput("");
    // A new message supersedes any pending confirmation on the server; mirror that here.
    setPending(null);
    push({ who: "user", text: clean });
    await drive({ text: clean });
  }

  async function answer(approved: boolean) {
    if (!pending) return;
    const p = pending;
    setPending(null);
    push({ who: "user", text: approved ? `✓ ${t.confirm}` : `✕ ${t.cancel}` });
    await drive({ resume: { interruptId: p.id, nonce: p.metadata.nonce, approved } });
  }

  async function logout() {
    if (s) await api.logout(s.token).catch(() => {});
    session.setCustomer(null);
    await navigate({ to: "/login" });
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(input);
  }

  return (
    <div className="chat-layout">
      <header className="topbar">
        <div className="brand small">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="20" height="20">
              <path d="M9 22 16 9l7 13" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <strong>LATAM Bank</strong>
          <span className="chip">{t.personas[s.persona] ?? s.persona}</span>
          <span className="chip">{s.language.toUpperCase()}</span>
        </div>
        <nav className="topbar-actions">
          <Link to="/trace/$session" params={{ session: s.sessionId }} target="_blank" className="ghost">
            {t.trace}
          </Link>
          <button type="button" className="ghost" onClick={logout}>
            {t.logout}
          </button>
        </nav>
      </header>

      <div className="chat-scroll" ref={scroller}>
        <div className="chat-column">
          {lines.length === 0 && (
            <div className="empty">
              <p className="muted">{t.empty}</p>
              <div className="suggestions">
                {t.suggestions.map((q) => (
                  <button key={q} type="button" className="suggestion" onClick={() => void send(q)} disabled={busy}>
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {lines.map((l) => (
            <div key={l.id} className={`bubble ${l.who}`}>
              {l.who === "agent" && <span className="bubble-label">{t.agent}</span>}
              <p>{l.text}</p>
            </div>
          ))}

          {pending && (
            <div className="confirm-card" role="group" aria-label={t.confirm}>
              <p>{pending.message}</p>
              <p className="muted small">{t.confirmHint}</p>
              <div className="row">
                <button type="button" className="primary" onClick={() => void answer(true)} disabled={busy}>
                  {t.confirm}
                </button>
                <button type="button" className="secondary" onClick={() => void answer(false)} disabled={busy}>
                  {t.cancel}
                </button>
                <span className="muted small push-right">
                  {t.expires} {new Date(pending.expiresAt).toLocaleTimeString()}
                </span>
              </div>
            </div>
          )}

          {busy && (
            <div className="typing" aria-live="polite">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
              <span className="muted small">{status.step ? (t.steps[status.step] ?? status.step) : "…"}</span>
            </div>
          )}

          {handedOff && <p className="notice">{t.handedOff}</p>}
          {expired && (
            <p className="notice error">
              {t.sessionExpired} <Link to="/login">→</Link>
            </p>
          )}
        </div>
      </div>

      <footer className="composer-wrap">
        <div className="statusline" aria-live="polite">
          {status.route && (
            <span className="chip mono" title="router">
              {status.route.label} · {(status.route.confidence * 100).toFixed(0)}%
            </span>
          )}
          {status.decision && <span className={`chip mono decision-${status.decision.action}`}>{status.decision.action}</span>}
          {status.ruleIds.map((r) => (
            <span key={r} className="chip mono rule">
              {r}
            </span>
          ))}
        </div>
        <form className="composer" onSubmit={onSubmit}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t.placeholder}
            maxLength={1000}
            disabled={expired}
            aria-label={t.placeholder}
          />
          <button className="primary" type="submit" disabled={busy || expired || !input.trim()}>
            {t.send}
          </button>
        </form>
      </footer>
    </div>
  );
}
