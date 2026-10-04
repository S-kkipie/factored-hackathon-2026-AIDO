import { useNavigate } from "@tanstack/react-router";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { TurnView } from "../api";
import { Avatar } from "../components/Brand";
import { DisputeCard, HandoffNotice, ProductCards, TransactionTable } from "../components/Cards";
import { useChat } from "../chat";
import { strings } from "../i18n";
import { session } from "../session";

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
  const { lines, busy, step, pending, handoffId, expired, send, answer } = useChat();
  const [input, setInput] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [lines, pending, step]);

  useEffect(() => {
    if (!busy) inputRef.current?.focus();
  }, [busy]);

  const submit = () => {
    const text = input.trim();
    if (!text || busy || expired) return;
    setInput("");
    void send(text);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
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
        onSubmit={(e) => {
          e.preventDefault();
          submit();
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
        />
        <button className="send" type="submit" disabled={busy || expired || !input.trim()} aria-label={t.send}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M4 12 20 4l-6 16-3-6.5z" fill="currentColor" />
          </svg>
        </button>
      </form>
      <p className="composer-note muted small">{t.disclaimer}</p>
    </main>
  );
}
