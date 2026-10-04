import type { ServingDb, Transaction } from "../server/db/serving";
import type { Row } from "./metrics";
import { ID } from "./system";

type TxView = {
  transaction_id: string;
  datetime: string;
  merchant: string | null;
  amount: number;
  currency: string;
  amount_usd: number | null;
  status: string;
  type: string;
  channel: string;
};

export interface Evidence {
  language: "es" | "pt";
  userMessages: string[];
  reply: string;
  products: { product_id: string; number_masked: string; type: string; balance: number; credit_limit: number | null; currency: string; status: string }[];
  transactions: TxView[];
}

const view = (t: Transaction): TxView => ({
  transaction_id: t.transaction_id,
  datetime: t.transaction_date,
  merchant: t.merchant_name,
  amount: t.amount,
  currency: t.currency,
  amount_usd: t.amount_usd,
  status: t.transaction_status,
  type: t.transaction_type,
  channel: t.channel,
});

/** How many of the customer's most recent transactions the evidence carries besides the ones the reply cites by id. */
export const RECENT_TRANSACTIONS = 30;

/**
 * What a judge (or a human) needs to check a reply: the conversation, the reply, and every record the system could
 * have cited — all products (with masked number, limit and status) and the customer's recent transactions plus any
 * transaction the reply names by id (with time and channel).
 */
export function evidenceFor(row: Row, serving: ServingDb): Evidence {
  const reply = row.t.turns.at(-1)?.reply ?? "";
  const ids = [...new Set(reply.match(ID) ?? [])];
  const recent = serving.transactions(row.s.customerId, { limit: RECENT_TRANSACTIONS });
  const cited = ids.flatMap((id) => {
    const t = serving.transaction(row.s.customerId, id);
    return t ? [t] : [];
  });
  const txs = [...new Map([...cited, ...recent].map((t) => [t.transaction_id, t])).values()];
  return {
    language: row.s.language,
    userMessages: row.s.turns.flatMap((t) => ("say" in t ? [t.say] : ["confirm" in t ? `[${t.confirm} button]` : ""])),
    reply,
    products: serving.products(row.s.customerId).map((p) => ({
      product_id: p.product_id,
      number_masked: p.product_number_masked,
      type: p.product_type,
      balance: p.current_balance,
      credit_limit: p.credit_limit,
      currency: p.currency,
      status: p.product_status,
    })),
    transactions: txs.map(view),
  };
}
