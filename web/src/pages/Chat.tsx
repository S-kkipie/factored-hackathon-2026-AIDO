import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type Interrupt, type TurnView, api, runAgent } from "../api";
import { Avatar, Wordmark } from "../components/Brand";
import { DisputeCard, HandoffNotice, ProductCards, TransactionTable } from "../components/Cards";
import { strings } from "../i18n";
import { session } from "../session";

interface Line {
  id: string;
  who: "user" | "assistant" | "agent" | "system";
  text: string;
  at: Date;
  view?: TurnView;
}

const LISTING_HEADERS = /^(Sus productos|Seus produtos|Movimientos|Movimentações):\s*$/;

/** When cards show the records, drop the template's bullet listing of the same records from the text. */
function textWithoutListing(text: string, view: TurnView | undefined): string {
  if (!view || !(view.products?.length || view.transactions?.length || view.candidates?.length)) return text;
  return text
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("•") && !LISTING_HEADERS.test(l.trim()))
    .join("\n")
    .trim();
}

const clock = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function ChatPage() {
  const navigate = useNavigate();
  const [s] = useState(() => session.customer());
  const lang = s?.language ?? "es";
  const t = strings[lang];
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [pending, setPending] = useState<{ interrupt: Interrupt; view?: TurnView } | null>(null);
  const [handoffId, setHandoffId] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const lastAgentId = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const push = useCallback((line: Omit<Line, "id" | "at">) => setLines((ls) => [...ls, { ...line, id: crypto.randomUUID(), at: new Date() }]), []);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [lines, pending, step]);

  // While a human holds the case, their replies arrive over a plain poll (the agent console is REST).
  useEffect(() => {
    if (!handoffId || !s) return;
    const tick = async () => {
      try {
        for (const m of await api.agentMessages(s.token, lastAgentId.current)) {
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
  }, [handoffId, s, push]);

  if (!s) return null;

  async function drive(body: Parameters<typeof runAgent>[2]) {
    if (!s) return;
    setBusy(true);
    setStep(null);
    let view: TurnView | undefined;
    try {
      for await (const e of runAgent(s.token, s.sessionId, body)) {
        switch (e.type) {
          case "STEP_STARTED":
            setStep(String(e.stepName));
            break;
          case "STATE_DELTA":
            for (const op of e.delta as { path: string; value: unknown }[]) {
              if (op.path === "/view") {
                view = op.value as TurnView;
                if (view.handoffId) setHandoffId(view.handoffId);
              }
              if (op.path === "/outcome" && op.value === "handed_off") setHandoffId((h) => h ?? "—");
            }
            break;
          case "TEXT_MESSAGE_CONTENT":
            push({ who: "assistant", text: String(e.delta), view });
            break;
          case "RUN_FINISHED": {
            const outcome = e.outcome as { type: string; interrupts?: Interrupt[] };
            const it = outcome.type === "interrupt" ? outcome.interrupts?.[0] : undefined;
            setPending(it ? { interrupt: it, view } : null);
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
      setStep(null);
      inputRef.current?.focus();
    }
  }

  async function send(text: string) {
    const clean = text.trim();
    if (!clean || busy || expired) return;
    setInput("");
    setPending(null); // a new message supersedes a pending confirmation on the server too
    push({ who: "user", text: clean });
    await drive({ text: clean });
  }

  async function answer(approved: boolean) {
    if (!pending) return;
    const it = pending.interrupt;
    setPending(null);
    push({ who: "user", text: approved ? t.confirm : t.cancel });
    await drive({ resume: { interruptId: it.id, nonce: it.metadata.nonce, approved } });
  }

  async function logout() {
    if (s) await api.logout(s.token).catch(() => {});
    session.setCustomer(null);
    await navigate({ to: "/login" });
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Wordmark size={34} sub={t.brandTagline} />
        <nav className="side-nav" aria-label={t.navLabel}>
          <span className="side-link active">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M4 5h16v11H8l-4 4z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            </svg>
            {t.assistantNav}
          </span>
        </nav>
        <section className="side-section">
          <h3>{t.quickTopics}</h3>
          {t.suggestions.map((q) => (
            <button key={q} type="button" className="side-topic" onClick={() => void send(q)} disabled={busy || expired}>
              {q}
            </button>
          ))}
        </section>
        <div className="side-foot">
          <div className="side-user">
            <span className="side-user-dot" aria-hidden="true" />
            <div>
              <div className="side-user-name">{t.personas[s.persona] ?? s.persona}</div>
              <div className="muted small">{lang === "es" ? "Español" : "Português"}</div>
            </div>
          </div>
          <button type="button" className="ghost full" onClick={logout}>
            {t.logout}
          </button>
        </div>
      </aside>

      <main className="chat-main">
        <header className="chat-header">
          <Avatar who="assistant" />
          <div>
            <div className="chat-title">Aida</div>
            <div className="muted small">
              <span className={`presence ${handoffId ? "away" : "on"}`} /> {handoffId ? t.withAgent : t.online}
            </div>
          </div>
          <span className="chat-secure muted small">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <rect x="5" y="10.5" width="14" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
              <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
            </svg>
            {t.secure}
          </span>
        </header>

        <div className="chat-scroll" ref={scroller}>
          <div className="chat-column">
            {lines.length === 0 && (
              <div className="welcome">
                <Avatar who="assistant" />
                <h2>{t.welcomeTitle}</h2>
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

            {lines.map((l) => {
              const text = l.who === "assistant" ? textWithoutListing(l.text, l.view) : l.text;
              return (
                <div key={l.id} className={`msg ${l.who}`}>
                  {(l.who === "assistant" || l.who === "agent") && <Avatar who={l.who} />}
                  <div className="msg-body">
                    {l.who === "agent" && <span className="msg-label">{t.agent}</span>}
                    {text && (
                      <div className="bubble">
                        <p>{text}</p>
                      </div>
                    )}
                    {l.view?.products && l.view.products.length > 0 && <ProductCards products={l.view.products} lang={lang} />}
                    {l.view?.transactions && l.view.transactions.length > 0 && <TransactionTable transactions={l.view.transactions} lang={lang} />}
                    {l.view?.candidates && l.view.candidates.length > 0 && !l.view.dispute && (
                      <TransactionTable transactions={l.view.candidates} lang={lang} caption={t.candidatesCaption} />
                    )}
                    {l.view?.dispute && <DisputeCard dispute={l.view.dispute} lang={lang} />}
                    {l.view?.handoffId && <HandoffNotice handoffId={l.view.handoffId} lang={lang} />}
                    <span className="msg-time">{clock(l.at)}</span>
                  </div>
                </div>
              );
            })}

            {pending && (
              <div className="msg assistant">
                <Avatar who="assistant" />
                <div className="msg-body wide">
                  <div className="confirm-card" role="group" aria-label={t.confirm}>
                    <div className="confirm-head">
                      <span className="confirm-badge">{t.confirmBadge}</span>
                      <span className="muted small">
                        {t.expires} {new Date(pending.interrupt.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                    <p>{textWithoutListing(pending.interrupt.message, pending.view)}</p>
                    {pending.view?.candidates && <TransactionTable transactions={pending.view.candidates} lang={lang} />}
                    <div className="row">
                      <button type="button" className="primary" onClick={() => void answer(true)} disabled={busy}>
                        {t.confirm}
                      </button>
                      <button type="button" className="secondary" onClick={() => void answer(false)} disabled={busy}>
                        {t.cancel}
                      </button>
                    </div>
                    <p className="muted small">{t.confirmHint}</p>
                  </div>
                </div>
              </div>
            )}

            {busy && (
              <div className="msg assistant">
                <Avatar who="assistant" />
                <div className="typing" aria-live="polite">
                  <span className="dot" />
                  <span className="dot" />
                  <span className="dot" />
                  <span className="muted small">{step ? (t.steps[step] ?? t.thinking) : t.thinking}</span>
                </div>
              </div>
            )}

            {expired && (
              <div className="banner error">
                {t.sessionExpired}{" "}
                <button type="button" className="link" onClick={() => void navigate({ to: "/login" })}>
                  {t.signInAgain}
                </button>
              </div>
            )}
          </div>
        </div>

        <form
          className="composer"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder={handoffId ? t.placeholderAgent : t.placeholder}
            maxLength={1000}
            rows={1}
            disabled={expired}
            aria-label={t.placeholder}
            autoFocus
          />
          <button className="send" type="submit" disabled={busy || expired || !input.trim()} aria-label={t.send}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M4 12 20 4l-6 16-3-6.5z" fill="currentColor" />
            </svg>
          </button>
        </form>
        <p className="composer-note muted small">{t.disclaimer}</p>
      </main>
    </div>
  );
}
