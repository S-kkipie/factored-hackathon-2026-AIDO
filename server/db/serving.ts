import type { Param, Sql } from "./sql";

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
  customer(customerId: string): Promise<Customer | null>;
  products(customerId: string): Promise<Product[]>;
  transactions(customerId: string, filter?: TxFilter): Promise<Transaction[]>;
  transaction(customerId: string, transactionId: string): Promise<Transaction | null>;
  complaints(customerId: string): Promise<Complaint[]>;
  demoUsers(): Promise<{ persona: string; customer_id: string }[]>;
  /** Approved purchases with a USD amount in [from, to), grouped by category. */
  spendingByCategory(customerId: string, from: string, to: string): Promise<{ category: string; usd: number; count: number }[]>;
  /** Approved purchases with a USD amount from `from` onwards, grouped by calendar month (YYYY-MM). */
  spendingByMonth(customerId: string, from: string): Promise<{ month: string; usd: number; count: number }[]>;
}

const TX_COLUMNS = `transaction_id, transaction_date, product_id, customer_id, transaction_type, transaction_category,
  amount, currency, amount_usd, channel, merchant_name, merchant_category, transaction_country, transaction_city,
  transaction_status, response_code, fraud_score`;

/** Read-only access to the `serving` schema. Every lookup is keyed by the session customer. */
export function openServing(sql: Sql): ServingDb {
  return {
    customer: (customerId) =>
      sql.one<Customer>(
        "select customer_id, first_name, last_name, country, segment, customer_status, detected_accent from serving.customers where customer_id = $1",
        [customerId],
      ),
    products: (customerId) =>
      sql.all<Product>(
        "select product_id, customer_id, product_type, product_number_masked, currency, current_balance, credit_limit, product_status from serving.products where customer_id = $1 order by product_id",
        [customerId],
      ),
    transactions(customerId, filter = {}) {
      const params: Param[] = [customerId];
      const where = ["customer_id = $1"];
      const add = (clause: (n: string) => string, value: Param) => {
        params.push(value);
        where.push(clause(`$${params.length}`));
      };
      if (filter.from) add((n) => `transaction_date >= ${n}`, filter.from);
      if (filter.to) add((n) => `transaction_date < ${n}`, filter.to);
      if (filter.merchant) add((n) => `lower(merchant_name) like ${n}`, `%${filter.merchant.toLowerCase()}%`);
      if (filter.minUsd !== undefined) add((n) => `amount_usd >= ${n}`, filter.minUsd);
      if (filter.maxUsd !== undefined) add((n) => `amount_usd <= ${n}`, filter.maxUsd);
      params.push(Math.trunc(filter.limit ?? 50));
      return sql.all<Transaction>(
        `select ${TX_COLUMNS} from serving.transactions where ${where.join(" and ")} order by transaction_date desc, transaction_id limit $${params.length}`,
        params,
      );
    },
    transaction: (customerId, transactionId) =>
      sql.one<Transaction>(`select ${TX_COLUMNS} from serving.transactions where customer_id = $1 and transaction_id = $2`, [
        customerId,
        transactionId,
      ]),
    complaints: (customerId) =>
      sql.all<Complaint>(
        "select complaint_id, customer_id, creation_date, category, subcategory, status, claimed_amount, currency, is_repeat_complainer, affected_product_id from serving.complaints where customer_id = $1 order by creation_date desc",
        [customerId],
      ),
    demoUsers: () => sql.all<{ persona: string; customer_id: string }>("select persona, customer_id from serving.demo_users order by persona"),
    spendingByCategory: (customerId, from, to) =>
      sql.all<{ category: string; usd: number; count: number }>(
        `select coalesce(transaction_category, 'Other') as category, sum(amount_usd)::float8 as usd, count(*)::int as count
         from serving.transactions
         where customer_id = $1 and transaction_type = 'Purchase' and transaction_status = 'Approved' and amount_usd is not null
           and transaction_date >= $2 and transaction_date < $3
         group by 1 order by usd desc`,
        [customerId, from, to],
      ),
    spendingByMonth: (customerId, from) =>
      sql.all<{ month: string; usd: number; count: number }>(
        `select substr(transaction_date, 1, 7) as month, sum(amount_usd)::float8 as usd, count(*)::int as count
         from serving.transactions
         where customer_id = $1 and transaction_type = 'Purchase' and transaction_status = 'Approved' and amount_usd is not null
           and transaction_date >= $2
         group by 1 order by 1`,
        [customerId, from],
      ),
  };
}
