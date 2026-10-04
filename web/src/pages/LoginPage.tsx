import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { BankCard, Guilloche, Logo, Waves, Wordmark } from "../Brand";
import { ApiError } from "../lib/api";
import { type Lang, PERSONAS, T, personaText } from "../lib/i18n";
import { loginRoute } from "../router";
import { clearCustomer, customerApi, readCustomer, writeCustomer } from "../session";

export function LoginPage() {
  const { expired } = loginRoute.useSearch();
  const navigate = useNavigate();
  const [personas, setPersonas] = useState<string[]>(Object.keys(PERSONAS));
  const [persona, setPersona] = useState("normal");
  const [lang, setLang] = useState<Lang>("es");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = T[lang];

  useEffect(() => {
    customerApi
      .demoUsers()
      .then((users) => {
        // Show personas in the scenario order of PERSONAS (normal first), unknown ones last.
        const order = Object.keys(PERSONAS);
        const rank = (p: string) => (order.includes(p) ? order.indexOf(p) : order.length);
        if (users.length > 0) setPersonas(users.map((u) => u.persona).sort((a, b) => rank(a) - rank(b)));
      })
      .catch(() => {
        // Keep the built-in persona list; login will report a real failure.
      });
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (readCustomer()) {
        try {
          await customerApi.logout();
        } catch {
          // Best-effort: the old server session may already be gone; log in fresh regardless.
        }
        clearCustomer();
      }
      const r = await customerApi.login(persona, pin, lang);
      writeCustomer({ token: r.token, sessionId: r.sessionId, language: r.language, persona, expiresAt: r.expiresAt });
      await navigate({ to: "/chat" });
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? t.loginFailed : t.turnFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <section className="auth-hero">
        <Guilloche className="hero-rosette" opacity={0.24} />
        <Waves className="hero-waves" opacity={0.18} />
        <Wordmark size={40} sub={t.brandTagline} light />
        <div className="hero-main">
          <div className="hero-copy">
            <h1>{t.loginTitle}</h1>
            <p>{t.loginSubtitle}</p>
            <ul className="hero-points">
              {t.heroPoints.map((point) => (
                <li key={point}>
                  <span className="hero-check" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="14" height="14">
                      <path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                  {point}
                </li>
              ))}
            </ul>
          </div>
          <div className="hero-stage" aria-hidden="true">
            <BankCard holder="CLIENTE AIDO" />
            <div className="hero-chat">
              <div className="preview-bubble user">{t.heroPreviewQuestion}</div>
              <div className="preview-bubble assistant">
                <Logo size={22} />
                <span>{t.heroPreviewAnswer}</span>
              </div>
            </div>
          </div>
        </div>
        <p className="hero-foot">{t.demoNote}</p>
      </section>

      <section className="auth-panel">
        <form onSubmit={submit} className="auth-form card">
          <div className="auth-head">
            <h2>{t.enter}</h2>
            <fieldset className="segmented">
              <legend>{t.language}</legend>
              {(["es", "pt"] as const).map((l) => (
                <label key={l} className={lang === l ? "selected" : ""}>
                  <input type="radio" name="lang" value={l} checked={lang === l} onChange={() => setLang(l)} />
                  {l === "es" ? "Español" : "Português"}
                </label>
              ))}
            </fieldset>
          </div>

          {expired && <p className="notice warn">{t.sessionExpired}</p>}

          <fieldset className="personas">
            <legend>{t.persona}</legend>
            {personas.map((p) => {
              const info = personaText(p, lang);
              return (
                <label key={p} className={`persona${persona === p ? " selected" : ""}`}>
                  <input type="radio" name="persona" value={p} checked={persona === p} onChange={() => setPersona(p)} />
                  <span className="persona-name">{info.name}</span>
                  <span className="persona-hint">{info.hint}</span>
                </label>
              );
            })}
          </fieldset>

          <label className="field">
            <span>{t.pin}</span>
            <input inputMode="numeric" autoComplete="off" maxLength={12} value={pin} onChange={(e) => setPin(e.target.value)} required />
            <small className="muted">{t.pinHint}</small>
          </label>

          {error && <p className="notice error">{error}</p>}

          <button type="submit" className="primary big" disabled={busy || pin.length === 0}>
            {t.enter}
          </button>

          <div className="auth-foot">
            <Link to="/agent">{t.agentConsole} →</Link>
          </div>
        </form>
      </section>
    </main>
  );
}
