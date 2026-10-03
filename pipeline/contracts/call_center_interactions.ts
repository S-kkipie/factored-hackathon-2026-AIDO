import { type Contract, col } from "./types";

export const callCenterInteractions: Contract = {
  table: "call_center_interactions",
  files: "call_center_interactions/**/*.csv",
  primaryKey: "interaction_id",
  documentedRows: 800_000,
  eventTime: "interaction_date",
  processDate: "process_date",
  columns: [
    col("interaction_id", "VARCHAR"),
    col("interaction_date", "TIMESTAMP"),
    col("process_date", "DATE"),
    col("customer_id", "VARCHAR"),
    col("channel", "VARCHAR", false, { enum: ["Phone", "Web Chat", "WhatsApp", "Email", "App", "Web"] }),
    col("reason_category", "VARCHAR", false, {
      enum: ["Transaccional", "Producto", "Queja", "Técnico", "Comercial", "Retención"],
    }),
    col("duration_seconds", "DOUBLE", true),
    col("wait_time_seconds", "DOUBLE", true),
    col("was_resolved", "BOOLEAN", true),
    col("was_escalated", "BOOLEAN"),
    col("detected_sentiment", "VARCHAR", true, {
      enum: ["Muy Negativo", "Negativo", "Neutral", "Positivo", "Muy Positivo"],
    }),
  ],
  foreignKeys: [{ column: "customer_id", references: { table: "customers", column: "customer_id" } }],
};
