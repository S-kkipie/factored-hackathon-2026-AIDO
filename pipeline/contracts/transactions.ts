import { type Contract, col } from "./types";

export const transactions: Contract = {
  table: "transactions",
  files: "transactions/**/*.csv",
  primaryKey: "transaction_id",
  documentedRows: 5_000_000,
  eventTime: "transaction_date",
  processDate: "process_date",
  columns: [
    col("transaction_id", "VARCHAR"),
    col("transaction_date", "TIMESTAMP"),
    col("process_date", "DATE"),
    col("product_id", "VARCHAR"),
    col("customer_id", "VARCHAR"),
    col("transaction_type", "VARCHAR", false, {
      enum: ["Deposit", "Withdrawal", "Transfer", "Payment", "Purchase", "Adjustment"],
    }),
    col("transaction_category", "VARCHAR", true, {
      enum: ["Food", "Transport", "Services", "Entertainment", "Health", "Other"],
    }),
    col("amount", "DOUBLE"),
    col("currency", "VARCHAR", false, { enum: ["MXN", "COP", "ARS", "USD"] }),
    col("amount_usd", "DOUBLE", true),
    col("channel", "VARCHAR", false, { enum: ["ATM", "Branch", "Web", "App", "POS", "Transfer"] }),
    col("merchant_name", "VARCHAR", true),
    col("merchant_category", "VARCHAR", true),
    col("transaction_country", "VARCHAR", false, {
      normalize: "case when {v} = 'Mexico' then 'México' else {v} end",
    }),
    col("transaction_city", "VARCHAR", true),
    col("transaction_status", "VARCHAR", false, { enum: ["Approved", "Declined", "Pending", "Reversed"] }),
    col("response_code", "VARCHAR", true),
    col("is_fraud", "BOOLEAN"),
    col("fraud_score", "DOUBLE", true),
  ],
  foreignKeys: [
    { column: "product_id", references: { table: "products", column: "product_id" } },
    { column: "customer_id", references: { table: "customers", column: "customer_id" } },
  ],
};
