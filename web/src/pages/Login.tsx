import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { ApiError, type Language, api } from "../api";
import { BankCard, Guilloche, Logo, Waves, Wordmark } from "../components/Brand";
import { strings } from "../i18n";
import { session } from "../session";

const PERSONA_ORDER = ["normal", "high_amount", "fraud_suspect", "repeat_complainer", "suspended"];

export function LoginPage() {
  const navigate = useNavigate();
  const [personas, setPersonas] = useState<string[]>([]);
  const [persona, setPersona] = useState("normal");
  const [language, setLanguage] = useState<Language>("es");
  const [pin, setPin] = useState("2468");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = strings[language];

  useEffect(() => {
    api
      .demoUsers()
      .then((users) => {
        const names = users.map((u) => u.persona).sort((a, b) => PERSONA_ORDER.indexOf(a) - PERSONA_ORDER.indexOf(b));
        setPersonas(names);
        setPersona((p) => (names.includes(p) ? p : (names[0] ?? p)));
      })
      .catch(() => setError(strings.es.serverDown));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.login(persona, pin, language);
      session.setCustomer({ token: r.token, sessionId: r.sessionId, persona, language, expiresAt: r.expiresAt });
      await navigate({ to: "/inicio" });
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? t.badCredentials : t.serverDown);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <section className="auth-hero">
        <Guilloche className="hero-rosette" opacity={0.24} />
        <Waves className="hero-waves" opacity={0.18} />
        <Wordmark size={44} sub={t.brandTagline} light />
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
            <BankCard masked="•••• 2370" label={language === "es" ? "Crédito" : "Crédito"} holder="VALENTINA R." />
            <div className="hero-chat">
              <div className="preview-bubble user">{t.suggestions[2]}</div>
              <div className="preview-bubble assistant">
                <Logo size={22} />
                <span>
                  {language === "es"
                    ? "Encontré el movimiento del 10 de junio. Confirme con el botón para registrar la disputa."
                    : "Encontrei a movimentação de 10 de junho. Confirme no botão para registrar a contestação."}
                </span>
              </div>
            </div>
          </div>
        </div>
        <p className="hero-foot">{t.demoNote}</p>
      </section>

      <section className="auth-panel">
        <form onSubmit={submit} className="auth-form">
          <div className="auth-head">
            <h2>{t.signIn}</h2>
            <div className="segmented" role="radiogroup" aria-label={t.language}>
              {(["es", "pt"] as const).map((l) => (
                <button key={l} type="button" role="radio" aria-checked={language === l} className={language === l ? "on" : ""} onClick={() => setLanguage(l)}>
                  {l === "es" ? "ES" : "PT"}
                </button>
              ))}
            </div>
          </div>

          <fieldset className="personas">
            <legend>{t.chooseCustomer}</legend>
            {personas.map((p) => (
              <label key={p} className={`persona${p === persona ? " selected" : ""}`}>
                <input type="radio" name="persona" value={p} checked={p === persona} onChange={() => setPersona(p)} />
                <span className="persona-name">{t.personas[p] ?? p}</span>
                <span className="persona-hint">{t.personaHints[p] ?? ""}</span>
              </label>
            ))}
          </fieldset>

          <label className="field">
            <span>{t.pin}</span>
            <input value={pin} onChange={(e) => setPin(e.target.value)} inputMode="numeric" type="password" maxLength={12} autoComplete="off" />
          </label>

          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}

          <button className="primary big" type="submit" disabled={busy || personas.length === 0}>
            {busy ? t.signingIn : t.signIn}
          </button>

          <div className="auth-foot">
            <Link to="/agent">{t.agentConsole} →</Link>
          </div>
        </form>
      </section>
    </main>
  );
}
