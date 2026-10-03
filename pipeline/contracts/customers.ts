import { type Contract, col } from "./types";

export const customers: Contract = {
  table: "customers",
  files: "customers.csv",
  primaryKey: "customer_id",
  documentedRows: 150_000,
  columns: [
    col("customer_id", "VARCHAR"),
    col("document_type", "VARCHAR", false, { enum: ["DNI", "CURP", "CC", "CE", "Passport", "Pasaporte"] }),
    col("first_name", "VARCHAR"),
    col("last_name", "VARCHAR"),
    col("country", "VARCHAR", false, { enum: ["Argentina", "Colombia", "México"] }),
    col("segment", "VARCHAR", false, { enum: ["Premium", "Plus", "Basic", "Student"] }),
    col("customer_status", "VARCHAR", false, { enum: ["Active", "Inactive", "Suspended", "Closed"] }),
    col("detected_accent", "VARCHAR", true, { enum: ["mexican", "colombian", "argentine", "neutral"] }),
    col("registration_date", "TIMESTAMP"),
    col("last_updated", "TIMESTAMP"),
  ],
};
