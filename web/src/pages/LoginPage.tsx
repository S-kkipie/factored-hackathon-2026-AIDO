import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import { type Lang, PERSONAS, T, personaText } from "../lib/i18n";
import { loginRoute } from "../router";
import { customerApi, writeCustomer } from "../session";

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
        if (users.length > 0) setPersonas(users.map((u) => u.persona));
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
    <section className="login">
      <h1>{t.loginTitle}</h1>
      <p className="muted">{t.loginLead}</p>
      {expired && <p className="notice warn">{t.sessionExpired}</p>}
      <form onSubmit={submit} className="login-form">
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
        <div className="row">
          <fieldset className="segmented">
            <legend>{t.language}</legend>
            {(["es", "pt"] as const).map((l) => (
              <label key={l} className={lang === l ? "selected" : ""}>
                <input type="radio" name="lang" value={l} checked={lang === l} onChange={() => setLang(l)} />
                {l === "es" ? "Español" : "Português"}
              </label>
            ))}
          </fieldset>
          <label className="field">
            <span>{t.pin}</span>
            <input inputMode="numeric" autoComplete="off" maxLength={12} value={pin} onChange={(e) => setPin(e.target.value)} required />
            <small className="muted">{t.pinHint}</small>
          </label>
        </div>
        {error && <p className="notice error">{error}</p>}
        <button type="submit" className="primary" disabled={busy || pin.length === 0}>
          {t.enter}
        </button>
      </form>
    </section>
  );
}
