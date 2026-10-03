import { type Contract, col } from "./types";

export const products: Contract = {
  table: "products",
  files: "products.csv",
  primaryKey: "product_id",
  documentedRows: 400_000,
  columns: [
    col("product_id", "VARCHAR"),
    col("customer_id", "VARCHAR"),
    col("product_type", "VARCHAR", false, {
      enum: [
        "Cuenta Ahorro",
        "Cuenta Corriente",
        "Tarjeta Crédito",
        "Tarjeta Débito",
        "Préstamo Personal",
        "Préstamo Hipotecario",
        "Inversión",
        "Seguro",
      ],
    }),
    col("product_number", "VARCHAR"),
    col("currency", "VARCHAR", false, { enum: ["MXN", "COP", "ARS", "USD"] }),
    col("current_balance", "DOUBLE"),
    col("credit_limit", "DOUBLE", true),
    col("product_status", "VARCHAR", false, { enum: ["Active", "Blocked", "Closed", "Suspended"] }),
    col("opening_date", "DATE"),
    col("last_updated", "TIMESTAMP"),
  ],
  foreignKeys: [{ column: "customer_id", references: { table: "customers", column: "customer_id" } }],
};
