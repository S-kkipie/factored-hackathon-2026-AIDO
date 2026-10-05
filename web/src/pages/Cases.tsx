import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ApiError, type CustomerCase, api } from "../api";
import { money } from "../format";
import { strings } from "../i18n";
import { session } from "../session";

/** Index of the current step on the case's 3-step track. */
const stepOf = (c: CustomerCase): number =>
  c.kind === "dispute" ? (c.status === "resolved" ? 2 : c.status === "in_review" ? 1 : 0) : c.status === "resolved" ? 2 : c.status === "taken" ? 1 : 0;

export function CasesPage() {
  const navigate = useNavigate();
  const [s] = useState(() => session.customer());
  const lang = s?.language ?? "es";
  const t = strings[lang];
  const [cases, setCases] = useState<CustomerCase[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!s) return;
    const load = () =>
      api
        .cases(s.token)
        .then(setCases)
        .catch((e) => setError(e instanceof ApiError && e.status === 401 ? t.sessionExpired : t.serverDown));
    void load();
    const timer = setInterval(load, 8000);
    return () => clearInterval(timer);
  }, [s, t.sessionExpired, t.serverDown]);

  if (!s) return null;
  const fmt = (iso: string) => new Date(iso).toLocaleString(lang === "es" ? "es-MX" : "pt-BR", { dateStyle: "medium", timeStyle: "short" });

  return (
    <main className="page narrow">
      <header className="page-head">
        <div>
          <h1>{t.casesTitle}</h1>
          <p className="muted">{t.casesSubtitle}</p>
        </div>
      </header>

      {error && <p className="banner error">{error}</p>}
      {!cases && !error && <p className="muted">{t.loading}</p>}
      {cases?.length === 0 && (
        <div className="empty-state panel">
          <p>{t.casesEmpty}</p>
          <button type="button" className="primary" onClick={() => void navigate({ to: "/chat" })}>
            {t.askAida}
          </button>
        </div>
      )}

      <div className="case-list">
        {cases?.map((c) => {
          const step = stepOf(c);
          const steps = t.caseSteps[c.kind] ?? [];
          return (
            <article key={c.id} className="case-item panel">
              <header className="case-item-head">
                <span className={`case-kind ${c.kind}`} aria-hidden="true">
                  {c.kind === "dispute" ? "⚑" : "☺"}
                </span>
                <div className="grow">
                  <div className="case-item-title">{c.kind === "dispute" ? t.caseDispute : t.caseHandoff}</div>
                  <div className="muted small">
                    <span className="mono">{c.id}</span> · {t.caseOpened} {fmt(c.createdAt)}
                  </div>
                </div>
                <span className={`pill ${step === 2 ? "status-approved" : step === 1 ? "status-pending" : ""}`}>{t.caseStatus[c.status] ?? c.status}</span>
              </header>

              <ol className="stepper" aria-label={t.caseStatus[c.status]}>
                {steps.map((label, i) => (
                  <li key={label} className={i < step ? "done" : i === step ? "current" : ""}>
                    <span className="stepper-dot" aria-hidden="true" />
                    <span>{label}</span>
                  </li>
                ))}
              </ol>

              {(c.reason || c.amountUsd !== null || c.transactionIds.length > 0) && (
                <dl className="result-facts">
                  {c.reason && (
                    <div>
                      <dt>{lang === "es" ? "Motivo" : "Motivo"}</dt>
                      <dd>{t.reasons[c.reason] ?? c.reason}</dd>
                    </div>
                  )}
                  {c.amountUsd !== null && (
                    <div>
                      <dt>{t.caseAmount}</dt>
                      <dd>{money(c.amountUsd, "USD", lang)}</dd>
                    </div>
                  )}
                  {c.transactionIds.length > 0 && (
                    <div>
                      <dt>{t.caseMovements}</dt>
                      <dd className="mono small">{c.transactionIds.map((id) => id.slice(-8)).join(", ")}</dd>
                    </div>
                  )}
                </dl>
              )}
            </article>
          );
        })}
      </div>
    </main>
  );
}
