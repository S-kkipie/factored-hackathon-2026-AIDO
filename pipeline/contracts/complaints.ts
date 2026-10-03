import { type Contract, col } from "./types";

export const complaints: Contract = {
  table: "complaints",
  files: "complaints/**/*.csv",
  primaryKey: "complaint_id",
  documentedRows: 80_000,
  eventTime: "creation_date",
  processDate: "process_date",
  columns: [
    col("complaint_id", "VARCHAR"),
    col("creation_date", "TIMESTAMP"),
    col("process_date", "DATE"),
    col("customer_id", "VARCHAR"),
    col("case_type", "VARCHAR", false, { enum: ["Complaint", "Claim", "Request", "Suggestion"] }),
    col("category", "VARCHAR", false, { enum: ["Transactions", "Fees", "Technical", "Branch", "Service"] }),
    col("subcategory", "VARCHAR", true, {
      enum: [
        "Cargo no reconocido",
        "Cobro indebido",
        "Problema con app",
        "Atención en sucursal",
        "Calidad de servicio",
      ],
    }),
    col("reception_channel", "VARCHAR", false, {
      enum: ["Call Center", "Email", "Web", "App", "Branch", "Regulator"],
    }),
    col("affected_product_id", "VARCHAR", true),
    col("description", "VARCHAR"),
    col("claimed_amount", "DOUBLE", true),
    col("currency", "VARCHAR", true, { enum: ["MXN", "COP", "ARS", "USD"] }),
    col("priority", "VARCHAR", false, { enum: ["Low", "Medium", "High", "Critical"] }),
    col("status", "VARCHAR", false, {
      enum: ["Open", "In Process", "Escalated", "Resolved", "Closed", "Rejected"],
    }),
    col("sla_breached", "BOOLEAN"),
    col("resolution_days", "INTEGER", true),
    col("resolution_satisfaction", "INTEGER", true),
    col("is_repeat_complainer", "BOOLEAN"),
  ],
  foreignKeys: [
    { column: "customer_id", references: { table: "customers", column: "customer_id" } },
    { column: "affected_product_id", references: { table: "products", column: "product_id" } },
  ],
};
