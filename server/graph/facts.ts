import type { Product, Transaction } from "../db/serving";
import type { ResponseFacts } from "../gates/response";
import { type Val, trusted } from "../provenance";
import type { Dispute } from "../tools";

export interface FactSources {
  products?: Val<Product[]>;
  transactions?: Val<Transaction[]>;
  dispute?: Val<Dispute>;
  handoffId?: Val<string>;
}

/**
 * Builds the response gate's allow-list from database records only (spec 4.5 gate 7). Anything not sourced from
 * `db` throws PROV_001: a number the model saw in the customer's message is never a grounded fact.
 */
export function factsFrom(sources: FactSources, templates: string[]): ResponseFacts {
  const facts: ResponseFacts = { amounts: [], ids: [], templates: [...templates] };
  for (const p of sources.products ? trusted("products", sources.products, ["db"]) : []) {
    facts.ids.push(p.product_id);
    facts.amounts.push({ value: p.current_balance, currency: p.currency });
    if (p.credit_limit !== null) {
      facts.amounts.push({ value: p.credit_limit, currency: p.currency });
      facts.amounts.push({ value: p.credit_limit - p.current_balance, currency: p.currency });
    }
  }
  for (const t of sources.transactions ? trusted("transactions", sources.transactions, ["db"]) : []) {
    facts.ids.push(t.transaction_id, t.product_id);
    facts.amounts.push({ value: t.amount, currency: t.currency });
    if (t.amount_usd !== null) facts.amounts.push({ value: t.amount_usd, currency: "USD" });
  }
  if (sources.dispute) {
    const d = trusted("dispute", sources.dispute, ["db"]);
    facts.ids.push(d.dispute_id, ...d.transaction_ids);
    facts.amounts.push({ value: d.amount_usd, currency: "USD" });
  }
  if (sources.handoffId) facts.ids.push(trusted("handoffId", sources.handoffId, ["db"]));
  facts.ids = [...new Set(facts.ids)];
  return facts;
}
