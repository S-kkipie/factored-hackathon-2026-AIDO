import { PGlite } from "@electric-sql/pglite";
import { buildDemoServing, seedDemo } from "../pipeline/demo";
import { type Sql, fromPglite, migrationSql } from "../server/db/sql";
import { type Tools } from "../server/tools";
import { ToolError } from "../server/tools/runtime";
import type { Scenario } from "./scenarios";

/**
 * Isolated databases for the evaluation: one migrated + demo-seeded PGlite template, and a copy-on-write clone per
 * scenario run, so runs never see each other's disputes or handoffs and never touch Supabase.
 */
let template: Promise<PGlite> | null = null;

function getTemplate(): Promise<PGlite> {
  template ??= (async () => {
    const pg = new PGlite();
    await pg.exec(migrationSql());
    await seedDemo(fromPglite(pg), buildDemoServing());
    return pg;
  })();
  return template;
}

export interface ScenarioDb {
  sql: Sql;
  close(): Promise<void>;
}

export async function scenarioDb(s: Scenario): Promise<ScenarioDb> {
  const pg = (await (await getTemplate()).clone()) as PGlite;
  if (s.seedSql) await pg.exec(s.seedSql);
  return { sql: fromPglite(pg), close: () => pg.close() };
}

export async function closeTemplate(): Promise<void> {
  if (template) await (await template).close();
  template = null;
}

/** Fault injection: the named tool always fails with a retryable error (both systems get the same failure). */
export function withFailure(s: Scenario): ((real: Tools) => Tools) | undefined {
  const tool = s.failTool;
  if (!tool) return undefined;
  return (real) => ({
    ...real,
    [tool]: async () => {
      throw new ToolError("TL_FAIL", tool, "injected failure (evaluation)", true);
    },
  });
}

export async function ownTransactionIds(sql: Sql, customerId: string): Promise<Set<string>> {
  const rows = await sql.all<{ id: string }>("select transaction_id as id from serving.transactions where customer_id = $1", [customerId]);
  return new Set(rows.map((r) => r.id));
}

export async function customerOf(sql: Sql, persona: string): Promise<string> {
  const row = await sql.one<{ c: string }>("select customer_id as c from serving.demo_users where persona = $1", [persona]);
  if (!row) throw new Error(`unknown persona ${persona}`);
  return row.c;
}

export async function effects(sql: Sql, customerId: string): Promise<{ disputes: string[][]; handoffs: number }> {
  const disputes = await sql.all<{ t: string }>("select transaction_ids as t from ops.disputes where customer_id = $1", [customerId]);
  const handoffs = await sql.one<{ n: number }>("select count(*)::int as n from ops.handoffs where customer_id = $1", [customerId]);
  return { disputes: disputes.map((d) => JSON.parse(d.t) as string[]), handoffs: handoffs?.n ?? 0 };
}
