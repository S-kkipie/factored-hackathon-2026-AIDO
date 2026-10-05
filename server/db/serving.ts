import { Database } from "bun:sqlite";

export interface Customer {
  customer_id: string;
  first_name: string;
  last_name: string;
  country: string;
  segment: string;
  customer_status: string;
  detected_accent: string | null;
}

export interface Product {
  product_id: string;
  customer_id: string;
  product_type: string;
  product_number_masked: string;
  currency: string;
  current_balance: number;
  credit_limit: number | null;
  product_status: string;
}

export interface Transaction {
  transaction_id: string;
  transaction_date: string;
  product_id: string;
  customer_id: string;
  transaction_type: string;
  transaction_category: string | null;
  amount: number;
  currency: string;
  amount_usd: number | null;
  channel: string;
  merchant_name: string | null;
  merchant_category: string | null;
  transaction_country: string;
  transaction_city: string | null;
  transaction_status: string;
  response_code: string | null;
  fraud_score: number | null;
}

export interface Complaint {
  complaint_id: string;
  customer_id: string;
  creation_date: string;
  category: string;
  subcategory: string | null;
  status: string;
  claimed_amount: number | null;
  currency: string | null;
  is_repeat_complainer: number;
  affected_product_id: string | null;
}

export interface TxFilter {
  /** Inclusive ISO date/time lower bound. */
  from?: string;
  /** Exclusive ISO date/time upper bound. */
  to?: string;
  merchant?: string;
  minUsd?: number;
  maxUsd?: number;
  limit?: number;
}

export interface ServingDb {
  customer(customerId: string): Customer | null;
  products(customerId: string): Product[];
  transactions(customerId: string, filter?: TxFilter): Transaction[];
  transaction(customerId: string, transactionId: string): Transaction | null;
  complaints(customerId: string): Complaint[];
  demoUsers(): { persona: string; customer_id: string }[];
  /** Approved purchases with a USD amount in [from, to), grouped by category. */
  spendingByCategory(customerId: string, from: string, to: string): { category: string; usd: number; count: number }[];
  /** Approved purchases with a USD amount from `from` onwards, grouped by calendar month (YYYY-MM). */
  spendingByMonth(customerId: string, from: string): { month: string; usd: number; count: number }[];
  close(): void;
}

const PURCHASES = "customer_id = ? and transaction_type = 'Purchase' and transaction_status = 'Approved' and amount_usd is not null";

/** Case- and accent-insensitive form for merchant matching ("Café Ñandú" → "cafe nandu"). */
export const foldText = (t: string): string => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const TX_COLUMNS = `transaction_id, transaction_date, product_id, customer_id, transaction_type, transaction_category,
  amount, currency, amount_usd, channel, merchant_name, merchant_category, transaction_country, transaction_city,
  transaction_status, response_code, fraud_score`;

type Params = Record<string, string | number>;

export function openServing(path: string): ServingDb {
  const db = new Database(path, { readonly: true });
  return {
    customer: (customerId) =>
      db
        .query<Customer, [string]>(
          "select customer_id, first_name, last_name, country, segment, customer_status, detected_accent from customers where customer_id = ?",
        )
        .get(customerId),
    products: (customerId) =>
      db
        .query<Product, [string]>(
          "select product_id, customer_id, product_type, product_number_masked, currency, current_balance, credit_limit, product_status from products where customer_id = ? order by product_id",
        )
        .all(customerId),
    transactions(customerId, filter = {}) {
      const where = ["customer_id = $customer"];
      const limit = filter.limit ?? 50;
      // A merchant filter is applied in JS (below), so SQL must not cut the rows first: -1 = no limit in SQLite.
      const params: Params = { $customer: customerId, $limit: filter.merchant ? -1 : limit };
      if (filter.from) {
        where.push("transaction_date >= $from");
        params.$from = filter.from;
      }
      if (filter.to) {
        where.push("transaction_date < $to");
        params.$to = filter.to;
      }
      if (filter.minUsd !== undefined) {
        where.push("amount_usd >= $minUsd");
        params.$minUsd = filter.minUsd;
      }
      if (filter.maxUsd !== undefined) {
        where.push("amount_usd <= $maxUsd");
        params.$maxUsd = filter.maxUsd;
      }
      const rows = db
        .query<Transaction, Params>(
          `select ${TX_COLUMNS} from transactions where ${where.join(" and ")} order by transaction_date desc limit $limit`,
        )
        .all(params);
      if (!filter.merchant) return rows;
      // SQLite's lower()/LIKE only fold ASCII, so "Café Ñandú" never matched "café ñandú": compare with
      // accents and case folded in JS instead.
      const wanted = foldText(filter.merchant);
      return rows.filter((r) => r.merchant_name !== null && foldText(r.merchant_name).includes(wanted)).slice(0, limit);
    },
    transaction: (customerId, transactionId) =>
      db
        .query<Transaction, [string, string]>(
          `select ${TX_COLUMNS} from transactions where customer_id = ? and transaction_id = ?`,
        )
        .get(customerId, transactionId),
    complaints: (customerId) =>
      db
        .query<Complaint, [string]>(
          "select complaint_id, customer_id, creation_date, category, subcategory, status, claimed_amount, currency, is_repeat_complainer, affected_product_id from complaints where customer_id = ? order by creation_date desc",
        )
        .all(customerId),
    demoUsers: () => db.query<{ persona: string; customer_id: string }, []>("select persona, customer_id from demo_users").all(),
    spendingByCategory: (customerId, from, to) =>
      db
        .query<{ category: string; usd: number; count: number }, [string, string, string]>(
          `select coalesce(transaction_category, 'Other') as category, sum(amount_usd) as usd, count(*) as count
           from transactions where ${PURCHASES} and transaction_date >= ? and transaction_date < ?
           group by 1 order by usd desc`,
        )
        .all(customerId, from, to),
    spendingByMonth: (customerId, from) =>
      db
        .query<{ month: string; usd: number; count: number }, [string, string]>(
          `select substr(transaction_date, 1, 7) as month, sum(amount_usd) as usd, count(*) as count
           from transactions where ${PURCHASES} and transaction_date >= ?
           group by 1 order by 1`,
        )
        .all(customerId, from),
    close: () => db.close(),
  };
}
