import { Database } from "bun:sqlite";
import { rm, rename } from "node:fs/promises";
import type { PipelineConfig } from "./config";
import type { Duck } from "./duck";
import { lit } from "./sql";

export type Persona = "normal" | "high_amount" | "fraud_suspect" | "repeat_complainer" | "suspended";

/** Indexes supporting the serving query patterns (per-customer lookups, persona lookup). */
const SERVING_INDEXES: readonly { name: string; table: string; columns: readonly string[] }[] = [
  { name: "idx_transactions_customer_date", table: "transactions", columns: ["customer_id", "transaction_date"] },
  { name: "idx_products_customer", table: "products", columns: ["customer_id"] },
  { name: "idx_complaints_customer", table: "complaints", columns: ["customer_id"] },
  { name: "idx_demo_users_persona", table: "demo_users", columns: ["persona"] },
];

/**
 * Creates the serving indexes. Tries DuckDB's sqlite attach first; if that extension doesn't
 * support CREATE INDEX on attached sqlite tables, falls back to opening the finished tmp file
 * directly with bun:sqlite (after `srv` is detached, so the file isn't locked by DuckDB).
 */
async function createServingIndexes(duck: Duck, tmpPath: string): Promise<void> {
  let viaDuckDb = true;
  try {
    for (const idx of SERVING_INDEXES) {
      // Attached sqlite databases have a single schema ("main"); DuckDB's binder rejects the
      // two-part "srv.<table>" form for DDL like CREATE INDEX, so qualify with it explicitly.
      await duck.run(`create index if not exists ${idx.name} on srv.main.${idx.table} (${idx.columns.join(", ")})`);
    }
  } catch {
    viaDuckDb = false;
  }
  await duck.run("detach srv");
  if (!viaDuckDb) {
    const sqliteDb = new Database(tmpPath);
    try {
      for (const idx of SERVING_INDEXES) {
        sqliteDb.run(`create index if not exists ${idx.name} on ${idx.table} (${idx.columns.join(", ")})`);
      }
    } finally {
      sqliteDb.close();
    }
  }
}

export interface CurateResult {
  customers: number;
  transactions: number;
  personas: Record<Persona, string>;
}

type CurateOptions = Pick<
  PipelineConfig,
  "servingPath" | "clock" | "windowDays" | "recentDays" | "subsetSize" | "seed" | "maxAutoUsd" | "fraudScore"
>;

/**
 * Builds serving.sqlite: a stratified customer subset plus hand-picked demo personas,
 * with PII minimized (no documents or contact data, masked product numbers).
 */
export async function curate(duck: Duck, o: CurateOptions): Promise<CurateResult> {
  const clock = `date ${lit(o.clock)}`;
  const windowStart = `(${clock} - interval ${o.windowDays} day)`;
  const recentStart = `(${clock} - interval ${o.recentDays} day)`;
  const end = `(${clock} + interval 1 day)`;
  const order = (column: string) => `hash(${column} || ${lit(String(o.seed))})`;
  const usd = (alias: string) =>
    `coalesce(${alias}.amount_usd, case when ${alias}.currency = 'USD' then ${alias}.amount end)`;

  await duck.run(`create or replace temp table _eligible as
    select c.customer_id, c.country, c.segment from stg.customers c
    where exists (select 1 from stg.transactions t
      where t.customer_id = c.customer_id and t.transaction_date >= ${windowStart} and t.transaction_date < ${end})`);

  await duck.run(`create or replace temp table _personas as
    with tx as (
      select t.*, ${usd("t")} as usd from stg.transactions t
      where t.transaction_date >= ${recentStart} and t.transaction_date < ${end}),
    cust as (select * from stg.customers where customer_id in (select customer_id from _eligible)),
    repeaters as (select distinct customer_id from stg.complaints where is_repeat_complainer),
    candidates as (
      select 'normal' as persona, customer_id from cust c
      where customer_status = 'Active'
        and customer_id not in (select customer_id from repeaters)
        and exists (select 1 from tx where tx.customer_id = c.customer_id and tx.transaction_type = 'Purchase'
          and tx.transaction_status = 'Approved' and tx.usd <= ${o.maxAutoUsd} and coalesce(tx.fraud_score, 0) < ${o.fraudScore})
      union all
      select 'high_amount', customer_id from cust c
      where customer_status = 'Active'
        and exists (select 1 from tx where tx.customer_id = c.customer_id and tx.transaction_type = 'Purchase'
          and tx.transaction_status = 'Approved' and tx.usd > ${o.maxAutoUsd} and coalesce(tx.fraud_score, 0) < ${o.fraudScore})
      union all
      select 'fraud_suspect', customer_id from cust c
      where customer_status = 'Active'
        and exists (select 1 from tx where tx.customer_id = c.customer_id and tx.fraud_score >= ${o.fraudScore})
      union all
      select 'repeat_complainer', customer_id from cust
      where customer_status = 'Active' and customer_id in (select customer_id from repeaters)
      union all
      select 'suspended', customer_id from cust where customer_status = 'Suspended')
    select persona, customer_id from candidates
    qualify row_number() over (partition by persona order by ${order("customer_id")}) = 1`);

  await duck.run(`create or replace temp table _subset as
    select customer_id from (
      select customer_id from _eligible
      qualify row_number() over (partition by country, segment order by ${order("customer_id")})
        <= greatest(1, round(${o.subsetSize} * count(*) over (partition by country, segment) / count(*) over ())))
    union
    select customer_id from _personas`);

  // Validate that all personas are present before building serving.sqlite
  const personaRows = await duck.all<{ persona: Persona; customer_id: string }>(
    "select distinct persona, customer_id from _personas order by persona",
  );
  const presentPersonas = new Set(personaRows.map((r) => r.persona));
  const allPersonas: Persona[] = ["fraud_suspect", "high_amount", "normal", "repeat_complainer", "suspended"];
  const missingPersonas = allPersonas.filter((p) => !presentPersonas.has(p));
  if (missingPersonas.length > 0) {
    throw new Error(`missing demo personas: ${missingPersonas.join(", ")}`);
  }

  const tmpPath = `${o.servingPath}.tmp`;
  await rm(tmpPath, { force: true });
  await duck.run(`install sqlite; load sqlite; attach ${lit(tmpPath)} as srv (type sqlite)`);
  try {
    const inSubset = "customer_id in (select customer_id from _subset)";
    await duck.run(`
      create table srv.customers as
        select customer_id, first_name, last_name, country, segment, customer_status, detected_accent, source_file, load_id
        from stg.customers where ${inSubset};
      create table srv.products as
        select product_id, customer_id, product_type, '****' || right(product_number, 4) as product_number_masked,
          currency, current_balance, credit_limit, product_status, source_file, load_id
        from stg.products where ${inSubset};
      create table srv.transactions as
        select transaction_id, strftime(transaction_date, '%Y-%m-%dT%H:%M:%S') as transaction_date, product_id, customer_id,
          transaction_type, transaction_category, amount, currency, ${usd("t")} as amount_usd, channel,
          merchant_name, merchant_category, transaction_country, transaction_city, transaction_status, response_code,
          fraud_score, source_file, load_id
        from stg.transactions t
        where ${inSubset} and transaction_date >= ${windowStart} and transaction_date < ${end};
      create table srv.complaints as
        select complaint_id, customer_id, strftime(creation_date, '%Y-%m-%dT%H:%M:%S') as creation_date, category,
          subcategory, status, claimed_amount, currency, is_repeat_complainer, affected_product_id, source_file, load_id
        from stg.complaints where ${inSubset};
      create table srv.demo_users as select persona, customer_id from _personas;
      create table srv.meta as select * from (values
        ('clock', ${lit(o.clock)}),
        ('window_days', ${lit(String(o.windowDays))}),
        ('built_at', strftime(now(), '%Y-%m-%dT%H:%M:%S'))) m(key, value);`);

    const counts = await duck.one<{ customers: number; transactions: number }>(`select
      (select count(*)::integer from srv.customers) as customers,
      (select count(*)::integer from srv.transactions) as transactions`);
    await createServingIndexes(duck, tmpPath);
    await rename(tmpPath, o.servingPath);
    return {
      ...counts,
      personas: Object.fromEntries(personaRows.map((r) => [r.persona, r.customer_id])) as Record<Persona, string>,
    };
  } catch (err) {
    try {
      await duck.run("detach srv");
    } catch {
      // already detached or not attached
    }
    await rm(tmpPath, { force: true });
    throw err;
  }
}
