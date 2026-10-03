import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { ApiError, type Language, api } from "../api";
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
        if (names.length && !names.includes(persona)) setPersona(names[0]!);
      })
      .catch(() => setError(strings.es.serverDown));
    // Load once; the persona default only matters if "normal" is missing from the data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.login(persona, pin, language);
      session.setCustomer({ token: r.token, sessionId: r.sessionId, persona, language, expiresAt: r.expiresAt });
      await navigate({ to: "/chat" });
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? t.badCredentials : t.serverDown);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <section className="login-card">
        <header className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="28" height="28">
              <path d="M9 22 16 9l7 13" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <div>
            <h1>LATAM Bank</h1>
            <p className="muted">{t.tagline}</p>
          </div>
        </header>

        <form onSubmit={submit} className="stack">
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

          <div className="row">
            <label className="field">
              <span>{t.language}</span>
              <select value={language} onChange={(e) => setLanguage(e.target.value as Language)}>
                <option value="es">Español</option>
                <option value="pt">Português</option>
              </select>
            </label>
            <label className="field">
              <span>{t.pin}</span>
              <input value={pin} onChange={(e) => setPin(e.target.value)} inputMode="numeric" maxLength={12} autoComplete="off" />
            </label>
          </div>

          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}

          <button className="primary" type="submit" disabled={busy || personas.length === 0}>
            {busy ? t.signingIn : t.signIn}
          </button>
        </form>

        <footer className="login-footer">
          <Link to="/agent">{t.agentConsole} →</Link>
          <span className="muted small">Synthetic data · Factored AI &amp; Data Hackathon 2026</span>
        </footer>
      </section>
    </main>
  );
}
