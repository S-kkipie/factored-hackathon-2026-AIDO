import type { Language, ViewDispute, ViewProduct, ViewTransaction } from "../api";
import { STATUS_LABEL, money, shortDate, timeOf } from "../format";

const T = {
  es: {
    balance: "Saldo",
    available: "Disponible",
    limit: "Cupo",
    used: "usado",
    date: "Fecha",
    merchant: "Comercio",
    channel: "Canal",
    amount: "Monto",
    status: "Estado",
    disputeTitle: "Disputa registrada",
    reference: "Referencia",
    inReview: "En revisión",
    disputed: "Monto disputado",
    movements: (n: number) => `${n} movimiento${n === 1 ? "" : "s"}`,
    handoffTitle: "Lo conectamos con un agente",
    handoffBody: "Ya tiene el contexto de su caso y le responderá por este chat.",
    unknownMerchant: "Sin comercio",
  },
  pt: {
    balance: "Saldo",
    available: "Disponível",
    limit: "Limite",
    used: "usado",
    date: "Data",
    merchant: "Estabelecimento",
    channel: "Canal",
    amount: "Valor",
    status: "Status",
    disputeTitle: "Contestação registrada",
    reference: "Referência",
    inReview: "Em análise",
    disputed: "Valor contestado",
    movements: (n: number) => `${n} movimentaç${n === 1 ? "ão" : "ões"}`,
    handoffTitle: "Conectamos você a um atendente",
    handoffBody: "Ele já tem o contexto do seu caso e vai responder por este chat.",
    unknownMerchant: "Sem estabelecimento",
  },
};

function ProductIcon({ type }: { type: string }) {
  const card = /tarjeta|cart/i.test(type);
  return (
    <span className={`product-icon ${card ? "card" : "account"}`} aria-hidden="true">
      {card ? (
        <svg viewBox="0 0 24 24" width="18" height="18">
          <rect x="2.5" y="5" width="19" height="14" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M2.5 9.5h19" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="18" height="18">
          <path d="M3 10 12 4l9 6M5 10v8m4-8v8m6-8v8m4-8v8M3 20h18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

export function ProductCards({ products, lang }: { products: ViewProduct[]; lang: Language }) {
  const t = T[lang];
  return (
    <div className="product-grid">
      {products.map((p) => {
        const credit = p.credit_limit !== null && p.credit_limit > 0;
        const usage = credit ? Math.min(1, Math.max(0, p.current_balance / p.credit_limit!)) : 0;
        return (
          <article key={p.product_id} className="product-card">
            <header>
              <ProductIcon type={p.product_type} />
              <div>
                <div className="product-type">{p.product_type}</div>
                <div className="product-number mono">{p.product_number_masked}</div>
              </div>
            </header>
            <div className="product-label">{t.balance}</div>
            <div className="product-balance">{money(p.current_balance, p.currency, lang)}</div>
            {credit && (
              <>
                <div className="usage" role="img" aria-label={`${Math.round(usage * 100)}% ${t.used}`}>
                  <span style={{ width: `${usage * 100}%` }} />
                </div>
                <div className="product-foot">
                  <span>
                    {t.available} <strong>{money(p.credit_limit! - p.current_balance, p.currency, lang)}</strong>
                  </span>
                  <span className="muted">
                    {t.limit} {money(p.credit_limit!, p.currency, lang)}
                  </span>
                </div>
              </>
            )}
          </article>
        );
      })}
    </div>
  );
}

function StatusPill({ status, lang }: { status: string; lang: Language }) {
  return <span className={`pill status-${status.toLowerCase()}`}>{STATUS_LABEL[lang][status] ?? status}</span>;
}

export function TransactionTable({ transactions, lang, caption }: { transactions: ViewTransaction[]; lang: Language; caption?: string }) {
  const t = T[lang];
  return (
    <div className="tx-table-wrap">
      {caption && <div className="tx-caption">{caption}</div>}
      <table className="tx-table">
        <thead>
          <tr>
            <th>{t.date}</th>
            <th>{t.merchant}</th>
            <th>{t.channel}</th>
            <th>{t.status}</th>
            <th className="num">{t.amount}</th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((x) => (
            <tr key={x.transaction_id}>
              <td>
                <div>{shortDate(x.transaction_date, lang)}</div>
                <div className="muted small">{timeOf(x.transaction_date)}</div>
              </td>
              <td>
                <div className="merchant">{x.merchant_name ?? t.unknownMerchant}</div>
                <div className="muted small mono" title={x.transaction_id}>
                  {x.transaction_category ?? x.transaction_type} · {x.transaction_id.slice(-6)}
                </div>
              </td>
              <td>{x.channel}</td>
              <td>
                <StatusPill status={x.transaction_status} lang={lang} />
              </td>
              <td className="num">
                <div className="amount">{money(x.amount, x.currency, lang)}</div>
                {x.currency !== "USD" && x.amount_usd !== null && <div className="muted small">≈ {money(x.amount_usd, "USD", lang)}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="tx-foot muted small">{t.movements(transactions.length)}</div>
    </div>
  );
}

export function DisputeCard({ dispute, lang }: { dispute: ViewDispute; lang: Language }) {
  const t = T[lang];
  return (
    <article className="result-card success">
      <span className="result-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20">
          <path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <div className="result-body">
        <div className="result-title">{t.disputeTitle}</div>
        <dl className="result-facts">
          <div>
            <dt>{t.reference}</dt>
            <dd className="mono">{dispute.dispute_id}</dd>
          </div>
          <div>
            <dt>{t.disputed}</dt>
            <dd>{money(dispute.amount_usd, "USD", lang)}</dd>
          </div>
          <div>
            <dt>{t.status}</dt>
            <dd>
              <span className="pill status-pending">{t.inReview}</span>
            </dd>
          </div>
        </dl>
      </div>
    </article>
  );
}

export function HandoffNotice({ handoffId, lang }: { handoffId: string; lang: Language }) {
  const t = T[lang];
  return (
    <article className="result-card info">
      <span className="result-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20">
          <circle cx="12" cy="8" r="3.6" fill="currentColor" />
          <path d="M5 20c0-3.9 3.1-6.2 7-6.2s7 2.3 7 6.2" fill="currentColor" />
        </svg>
      </span>
      <div className="result-body">
        <div className="result-title">{t.handoffTitle}</div>
        <p className="muted">{t.handoffBody}</p>
        <div className="small">
          {t.reference} <span className="mono">{handoffId}</span>
        </div>
      </div>
    </article>
  );
}
