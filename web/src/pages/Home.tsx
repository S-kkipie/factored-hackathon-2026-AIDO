import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ApiError, type CustomerOverview, api } from "../api";
import { BankCard, Guilloche, Waves } from "../components/Brand";
import { ProductCards, TransactionTable } from "../components/Cards";
import { BarList, Columns } from "../components/Charts";
import { useChat } from "../chat";
import { money, shortDate } from "../format";
import { strings } from "../i18n";
import { session } from "../session";

const CATEGORY: Record<string, Record<string, string>> = {
  es: { Food: "Alimentos", Health: "Salud", Entertainment: "Entretenimiento", Transport: "Transporte", Travel: "Viajes", Education: "Educación", Electronics: "Electrónica", Clothing: "Ropa", Other: "Otros" },
  pt: { Food: "Alimentação", Health: "Saúde", Entertainment: "Entretenimento", Transport: "Transporte", Travel: "Viagens", Education: "Educação", Electronics: "Eletrônicos", Clothing: "Roupas", Other: "Outros" },
};

const monthLabel = (ym: string, lang: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Intl.DateTimeFormat(lang === "es" ? "es-MX" : "pt-BR", { month: "short", timeZone: "UTC" }).format(Date.UTC(y!, (m ?? 1) - 1, 1));
};

export function HomePage() {
  const navigate = useNavigate();
  const chat = useChat();
  const [s] = useState(() => session.customer());
  const lang = s?.language ?? "es";
  const t = strings[lang];
  const [data, setData] = useState<CustomerOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!s) return;
    api
      .overview(s.token)
      .then(setData)
      .catch((e) => setError(e instanceof ApiError && e.status === 401 ? t.sessionExpired : t.serverDown));
  }, [s, t.sessionExpired, t.serverDown]);

  const ask = async (q: string) => {
    await navigate({ to: "/chat" });
    void chat.send(q);
  };

  if (!s) return null;
  const total30 = data?.spending30d.reduce((sum, c) => sum + c.usd, 0) ?? 0;
  const credit = data?.products.find((p) => p.credit_limit !== null);

  return (
    <main className="page">
      <section className="home-hero">
        <Guilloche className="home-hero-rosette" opacity={0.3} />
        <Waves className="home-hero-waves" opacity={0.16} />
        <div className="home-hero-copy">
          <span className="home-hero-eyebrow">{data ? `${t.asOf} ${shortDate(data.asOf, lang)}` : t.loading}</span>
          <h1>
            {t.goodDay}
            {data?.customer ? `, ${data.customer.firstName}` : ""}
          </h1>
          <div className="home-hero-stats">
            <div>
              <span className="stat-label">{t.spending30}</span>
              <span className="stat-value">{money(total30, "USD", lang)}</span>
            </div>
            {credit && credit.credit_limit !== null && (
              <div>
                <span className="stat-label">{t.creditAvailable}</span>
                <span className="stat-value">{money(credit.credit_limit - credit.current_balance, credit.currency, lang)}</span>
              </div>
            )}
          </div>
          <div className="row">
            <button type="button" className="gold" onClick={() => void navigate({ to: "/chat" })}>
              {t.askAida}
            </button>
            <button type="button" className="glass" onClick={() => void ask(t.suggestions[2]!)}>
              {t.qaReport}
            </button>
          </div>
        </div>
        {credit && <BankCard masked={credit.product_number_masked} label={t.creditLabel} holder={data?.customer?.firstName.toUpperCase()} />}
      </section>

      {error && <p className="banner error">{error}</p>}
      {!data && !error && <p className="muted">{t.loading}</p>}

      {data && (
        <>
          <section className="section">
            <h3>{t.yourAccounts}</h3>
            <ProductCards products={data.products} lang={lang} />
          </section>

          <div className="grid-2">
            <section className="panel">
              <div className="panel-head">
                <h2>{t.spending30}</h2>
                <span className="panel-figure">{money(total30, "USD", lang)}</span>
              </div>
              <BarList
                caption={t.spending30}
                empty={t.noSpending}
                items={data.spending30d.map((c) => ({
                  label: CATEGORY[lang]?.[c.category] ?? c.category,
                  value: c.usd,
                  display: money(c.usd, "USD", lang),
                  detail: t.purchases(c.count),
                }))}
              />
            </section>
            <section className="panel">
              <div className="panel-head">
                <h2>{t.monthlyTrend}</h2>
                <span className="muted small">USD</span>
              </div>
              <Columns
                caption={t.monthlyTrend}
                items={data.monthly.map((m) => ({
                  label: monthLabel(m.month, lang),
                  value: m.usd,
                  display: money(m.usd, "USD", lang),
                  detail: t.purchases(m.count),
                }))}
              />
            </section>
          </div>

          <div className="grid-main-side">
            <section className="section">
              <h3>{t.recentMovements}</h3>
              <TransactionTable transactions={data.recent} lang={lang} />
            </section>
            <aside className="panel actions-panel">
              <h2>{t.quickActions}</h2>
              <button type="button" className="action" onClick={() => void ask(t.suggestions[2]!)}>
                <span className="action-icon warn" aria-hidden="true">!</span>
                <span>
                  <strong>{t.qaReport}</strong>
                  <span className="muted small">{t.suggestions[2]}</span>
                </span>
              </button>
              <button type="button" className="action" onClick={() => void ask(t.suggestions[1]!)}>
                <span className="action-icon" aria-hidden="true">≡</span>
                <span>
                  <strong>{t.recentMovements}</strong>
                  <span className="muted small">{t.suggestions[1]}</span>
                </span>
              </button>
              <button type="button" className="action" onClick={() => void ask(t.suggestions[3]!)}>
                <span className="action-icon gold" aria-hidden="true">☺</span>
                <span>
                  <strong>{t.qaHuman}</strong>
                  <span className="muted small">{t.suggestions[3]}</span>
                </span>
              </button>
              <p className="muted small">{t.disclaimer}</p>
            </aside>
          </div>
        </>
      )}
    </main>
  );
}
