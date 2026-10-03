import type { Customer, Product, Transaction } from "../db/serving";
import type { Dispute } from "./index";

/** Projections of database rows that may be shown to the model. Built field by field: nothing is spread. */

export interface ModelTransaction {
  transaction_id: string;
  transaction_date: string;
  merchant_name: string | null;
  amount: number;
  currency: string;
  amount_usd: number | null;
  transaction_status: string;
  channel: string;
  transaction_type: string;
  transaction_category: string | null;
}

export const toModelTransaction = (t: Transaction): ModelTransaction => ({
  transaction_id: t.transaction_id,
  transaction_date: t.transaction_date,
  merchant_name: t.merchant_name,
  amount: t.amount,
  currency: t.currency,
  amount_usd: t.amount_usd,
  transaction_status: t.transaction_status,
  channel: t.channel,
  transaction_type: t.transaction_type,
  transaction_category: t.transaction_category,
});

export interface ModelProduct {
  product_id: string;
  product_type: string;
  product_number_masked: string;
  currency: string;
  current_balance: number;
  credit_limit: number | null;
  product_status: string;
}

export const toModelProduct = (p: Product): ModelProduct => ({
  product_id: p.product_id,
  product_type: p.product_type,
  product_number_masked: p.product_number_masked,
  currency: p.currency,
  current_balance: p.current_balance,
  credit_limit: p.credit_limit,
  product_status: p.product_status,
});

export interface ModelCustomer {
  first_name: string;
  segment: string;
  country: string;
  customer_status: string;
}

/** Only the first-name initial reaches the model. */
export const toModelCustomer = (c: Customer): ModelCustomer => ({
  first_name: c.first_name ? `${[...c.first_name.trim()][0] ?? ""}.` : "",
  segment: c.segment,
  country: c.country,
  customer_status: c.customer_status,
});

export interface ModelDispute {
  dispute_id: string;
  transaction_ids: string[];
  reason: string;
  amount_usd: number;
  status: string;
  created_at: string;
}

/** The untrusted customer note is never shown to the model (stored-injection defense). */
export const toModelDispute = (d: Dispute): ModelDispute => ({
  dispute_id: d.dispute_id,
  transaction_ids: [...d.transaction_ids],
  reason: d.reason,
  amount_usd: d.amount_usd,
  status: d.status,
  created_at: d.created_at,
});
