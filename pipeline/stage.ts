import { join, relative } from "node:path";
import type { Contract } from "./contracts/types";
import type { Duck } from "./duck";
import { ident, lit } from "./sql";
import { typedSelectSql } from "./validate";

export interface SourceFile {
  path: string;
  size: number;
}

export interface StageResult {
  table: string;
  filesLoaded: number;
  rowsRead: number;
  rejected: number;
  duplicatesInBatch: number;
  inserted: number;
  updated: number;
  missingColumns: string[];
  unexpectedColumns: string[];
}

export async function ensureStagingSchema(duck: Duck): Promise<void> {
  await duck.run(`
    create schema if not exists stg;
    create table if not exists stg._loaded_files (
      table_name varchar, source_file varchar, size bigint, load_id varchar,
      primary key (table_name, source_file));
    create table if not exists stg._rejects (
      table_name varchar, pk varchar, reasons varchar, source_file varchar, load_id varchar);
    create table if not exists stg._load_log (
      load_id varchar, table_name varchar, files_loaded integer, rows_read integer,
      rejected integer, duplicates_in_batch integer, inserted integer, updated integer,
      missing_columns varchar, unexpected_columns varchar, loaded_at timestamp);`);
}

/** Forward-slash path, so stored source_file values and DuckDB filenames match on Windows too. */
const posix = (p: string): string => p.replaceAll("\\", "/");

export async function listSourceFiles(rawDir: string, pattern: string): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  for await (const rel of new Bun.Glob(pattern).scan({ cwd: rawDir })) {
    const path = posix(join(rawDir, rel));
    files.push({ path, size: Bun.file(path).size });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function tableDdl(contract: Contract): string {
  const columns = contract.columns.map((c) => `${ident(c.name)} ${c.type}`).join(", ");
  return `create table if not exists stg.${ident(contract.table)} (${columns}, source_file varchar, load_id varchar, primary key (${ident(contract.primaryKey)}))`;
}

/**
 * Incremental, idempotent load of one table.
 * - A file is (re)loaded when its path (relative to rawDir) is new or its size changed.
 * - Rows violating the contract go to stg._rejects with their reasons.
 * - Within a batch, the row from the lexically latest file wins (partition paths are zero-padded dates).
 * - Across batches, the row from the lexically latest source file wins; re-loading the same file replaces its rows.
 */
export async function stageTable(
  duck: Duck,
  contract: Contract,
  files: readonly SourceFile[],
  rawDir: string,
  loadId: string,
): Promise<StageResult> {
  await duck.run(tableDdl(contract));
  const relOf = (path: string): string => posix(relative(rawDir, path));
  const table = `stg.${ident(contract.table)}`;
  const pk = ident(contract.primaryKey);

  const loaded = await duck.all<{ source_file: string; size: number }>(
    `select source_file, size::double as size from stg._loaded_files where table_name = ${lit(contract.table)}`,
  );
  const known = new Map(loaded.map((r) => [r.source_file, Number(r.size)]));
  const pending = files.filter((f) => known.get(relOf(f.path)) !== f.size);
  const result: StageResult = {
    table: contract.table,
    filesLoaded: pending.length,
    rowsRead: 0,
    rejected: 0,
    duplicatesInBatch: 0,
    inserted: 0,
    updated: 0,
    missingColumns: [],
    unexpectedColumns: [],
  };
  if (pending.length === 0) return result;

  const root = posix(rawDir);
  const prefix = root.endsWith("/") ? root : `${root}/`;
  await duck.run(`create or replace temp table _batch as
    select * exclude (filename), replace(filename, ${lit(prefix)}, '') as source_file
    from read_csv([${pending.map((f) => lit(posix(f.path))).join(", ")}],
      all_varchar = true, union_by_name = true, filename = true, hive_partitioning = false)`);

  const batchColumns = (await duck.all<{ column_name: string }>("select column_name from (describe _batch)"))
    .map((r) => r.column_name)
    .filter((name) => name !== "source_file");
  const present = new Set(batchColumns);
  const declared = new Set(contract.columns.map((c) => c.name));
  result.missingColumns = [...declared].filter((name) => !present.has(name));
  result.unexpectedColumns = batchColumns.filter((name) => !declared.has(name));

  await duck.run(`create or replace temp table _typed as ${typedSelectSql(contract, present)}`);
  await duck.run(`create or replace temp table _clean as
    select * exclude (_reasons) from _typed where _reasons = ''
    qualify row_number() over (partition by ${pk} order by source_file desc) = 1`);

  const counts = await duck.one<{
    rows_read: number;
    rejected: number;
    valid: number;
    clean: number;
    stale: number;
    updated_count: number;
  }>(
    `select
      (select count(*)::integer from _typed) as rows_read,
      (select count(*)::integer from _typed where _reasons <> '') as rejected,
      (select count(*)::integer from _typed where _reasons = '') as valid,
      (select count(*)::integer from _clean) as clean,
      (select count(*)::integer from _clean c where exists (select 1 from ${table} s where s.${pk} = c.${pk} and c.source_file < s.source_file)) as stale,
      (select count(*)::integer from _clean c where exists (select 1 from ${table} s where s.${pk} = c.${pk} and c.source_file >= s.source_file)) as updated_count`,
  );

  result.rowsRead = counts.rows_read;
  result.rejected = counts.rejected;
  result.duplicatesInBatch = counts.valid - counts.clean;
  result.updated = counts.updated_count;
  result.inserted = counts.clean - counts.updated_count - counts.stale;

  const columns = [...contract.columns.map((c) => ident(c.name)), "source_file"].join(", ");
  const updateCols = contract.columns.map((c) => `${ident(c.name)} = excluded.${ident(c.name)}`).join(", ");
  const pendingRelPaths = pending.map((f) => relOf(f.path));
  const fileRows = pending
    .map((f) => `(${lit(contract.table)}, ${lit(relOf(f.path))}, ${f.size}, ${lit(loadId)})`)
    .join(", ");

  // All per-table load writes happen atomically: a crash mid-load cannot leave
  // stale rejects, a half-applied upsert, or a dangling _loaded_files entry.
  await duck.run("begin transaction");
  try {
    // Rejects for files in this batch are recomputed from scratch; drop any
    // earlier rejects for the same source files before inserting the new ones.
    await duck.run(`delete from stg._rejects
      where table_name = ${lit(contract.table)} and source_file in (${pendingRelPaths.map(lit).join(", ")})`);
    await duck.run(`insert into stg._rejects
      select ${lit(contract.table)}, cast(${pk} as varchar), _reasons, source_file, ${lit(loadId)}
      from _typed where _reasons <> ''`);
    await duck.run(`insert into ${table} (${columns}, load_id)
      select ${columns}, ${lit(loadId)} from _clean
      where not exists (select 1 from ${table} s where s.${pk} = _clean.${pk} and s.source_file > _clean.source_file)
      on conflict (${pk}) do update set ${updateCols}, source_file = excluded.source_file, load_id = excluded.load_id`);
    await duck.run(`insert or replace into stg._loaded_files values ${fileRows}`);
    await duck.run(`insert into stg._load_log (
        load_id, table_name, files_loaded, rows_read, rejected, duplicates_in_batch, inserted, updated,
        missing_columns, unexpected_columns, loaded_at)
      values (${lit(loadId)}, ${lit(contract.table)}, ${result.filesLoaded}, ${result.rowsRead}, ${result.rejected},
        ${result.duplicatesInBatch}, ${result.inserted}, ${result.updated},
        ${lit(result.missingColumns.join(","))}, ${lit(result.unexpectedColumns.join(","))}, now())`);
    await duck.run("commit");
  } catch (err) {
    await duck.run("rollback");
    throw err;
  }

  return result;
}
