import type { ServingDb } from "../server/db/serving";
import type { Row } from "./metrics";
import { ID } from "./system";

export interface Evidence {
  language: "es" | "pt";
  userMessages: string[];
  reply: string;
  products: { product_id: string; type: string; balance: number; currency: string }[];
  transactions: { transaction_id: string; date: string; merchant: string | null; amount: number; currency: string; status: string; type: string }[];
}

/** What a judge (or a human) needs to check a reply: the conversation, the reply, and the customer's records it may cite. */
export function evidenceFor(row: Row, serving: ServingDb): Evidence {
  const reply = row.t.turns.at(-1)?.reply ?? "";
  const ids = [...new Set(reply.match(ID) ?? [])];
  return {
    language: row.s.language,
    userMessages: row.s.turns.flatMap((t) => ("say" in t ? [t.say] : ["confirm" in t ? `[${t.confirm} button]` : ""])),
    reply,
    products: serving.products(row.s.customerId).map((p) => ({ product_id: p.product_id, type: p.product_type, balance: p.current_balance, currency: p.currency })),
    transactions: ids.flatMap((id) => {
      const t = serving.transaction(row.s.customerId, id);
      return t
        ? [{ transaction_id: t.transaction_id, date: t.transaction_date.slice(0, 10), merchant: t.merchant_name, amount: t.amount, currency: t.currency, status: t.transaction_status, type: t.transaction_type }]
        : [];
    }),
  };
}
