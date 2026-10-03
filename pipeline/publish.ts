import { Database } from "bun:sqlite";
import { join } from "node:path";
import { databaseOptions } from "../server/config";
import { insertRows, truncateServing } from "../server/db/load";
import { type Param, type Sql, openDatabase } from "../server/db/sql";
import { ROOT } from "./config";
import { COLUMNS } from "./demo";

/**
 * Publishes the curated `serving.sqlite` (from `bun run pipeline`) into the Postgres `serving` schema — Supabase
 * when DATABASE_URL is set, local PGlite otherwise. Replaces the schema contents atomically; ops state is untouched.
 */
export async function publishServing(sql: Sql, servingPath: string): Promise<Record<string, number>> {
  const src = new Database(servingPath, { readonly: true });
  try {
    const read = (table: keyof typeof COLUMNS): Param[][] =>
      src
        .query<Record<string, Param>, []>(`select ${COLUMNS[table].join(", ")} from ${table}`)
        .all()
        .map((row) => COLUMNS[table].map((c) => row[c] ?? null));
    const data = Object.fromEntries((Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]).map((t) => [t, read(t)])) as Record<
      keyof typeof COLUMNS,
      Param[][]
    >;
    return await sql.tx(async (tx) => {
      await truncateServing(tx);
      const counts: Record<string, number> = {};
      for (const table of Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]) {
        counts[table] = await insertRows(tx, `serving.${table}`, COLUMNS[table], data[table]);
      }
      return counts;
    });
  } finally {
    src.close();
  }
}

if (import.meta.main) {
  const servingPath = process.env.SERVING_PATH ?? join(ROOT, "data/serving.sqlite");
  const opts = databaseOptions();
  const sql = await openDatabase(opts);
  try {
    const counts = await publishServing(sql, servingPath);
    console.log(`${servingPath} → ${opts.databaseUrl ? "Postgres (DATABASE_URL)" : `PGlite ${opts.pgliteDir}`}`);
    console.log(counts);
  } finally {
    await sql.close();
  }
}
