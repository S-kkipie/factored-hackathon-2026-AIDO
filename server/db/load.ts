import type { Param, Sql } from "./sql";

/** Postgres caps a statement at 65,535 bind parameters; stay well below it. */
const MAX_PARAMS = 30_000;

/** Bulk insert in multi-row batches. Identifiers come from code (contracts), never from data. */
export async function insertRows(
  sql: Sql,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly Param[])[],
): Promise<number> {
  if (!/^[a-z_]+\.[a-z_]+$/.test(table) || !columns.every((c) => /^[a-z_]+$/.test(c))) {
    throw new Error(`unsafe identifier in insert into ${table}`);
  }
  const perBatch = Math.max(1, Math.floor(MAX_PARAMS / columns.length));
  let inserted = 0;
  for (let i = 0; i < rows.length; i += perBatch) {
    const batch = rows.slice(i, i + perBatch);
    const params: Param[] = [];
    const tuples = batch.map((row) => {
      if (row.length !== columns.length) throw new Error(`row width ${row.length} != ${columns.length} for ${table}`);
      const marks = row.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      return `(${marks.join(", ")})`;
    });
    inserted += await sql.run(`insert into ${table} (${columns.join(", ")}) values ${tuples.join(", ")}`, params);
  }
  return inserted;
}

export const SERVING_TABLES = ["customers", "products", "transactions", "complaints", "demo_users", "meta"] as const;

/** Empties the serving schema (ops state is left alone). */
export async function truncateServing(sql: Sql): Promise<void> {
  await sql.exec(`truncate ${SERVING_TABLES.map((t) => `serving.${t}`).join(", ")}`);
}
