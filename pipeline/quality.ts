import type { Contract } from "./contracts/types";
import type { Duck } from "./duck";
import { mdTable } from "./markdown";
import { ident, lit } from "./sql";

/** Load totals for one table, aggregated across every run recorded in stg._load_log. */
export interface LoadHistoryRow {
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

export interface TableQuality {
  table: string;
  stagedRows: number;
  documentedRows: number;
  rejectsByReason: { reason: string; n: number }[];
  nullRates: { column: string; pct: number }[];
  orphans: { column: string; references: string; n: number }[];
  contentDuplicates: number;
  lagDays: { avg: number; min: number; max: number } | null;
}

export async function assessTable(duck: Duck, contract: Contract): Promise<TableQuality> {
  const table = `stg.${ident(contract.table)}`;
  const { n: stagedRows } = await duck.one<{ n: number }>(`select count(*)::integer as n from ${table}`);

  const rejectsByReason = await duck.all<{ reason: string; n: number }>(`
    select reason, count(*)::integer as n
    from (select unnest(string_split(reasons, ';')) as reason from stg._rejects where table_name = ${lit(contract.table)})
    group by 1 order by n desc, 1`);

  const nullable = contract.columns.filter((c) => c.nullable).map((c) => c.name);
  let nullRates: TableQuality["nullRates"] = [];
  if (nullable.length > 0) {
    const row = await duck.one<Record<string, number>>(
      `select ${nullable
        .map((c) => `round(100.0 * count(*) filter (where ${ident(c)} is null) / greatest(count(*), 1), 2) as ${ident(c)}`)
        .join(", ")} from ${table}`,
    );
    nullRates = nullable.map((column) => ({ column, pct: Number(row[column]) }));
  }

  const orphans: TableQuality["orphans"] = [];
  for (const fk of contract.foreignKeys ?? []) {
    const { n } = await duck.one<{ n: number }>(`
      select count(*)::integer as n from ${table} x
      where x.${ident(fk.column)} is not null and not exists (
        select 1 from stg.${ident(fk.references.table)} p where p.${ident(fk.references.column)} = x.${ident(fk.column)})`);
    orphans.push({ column: fk.column, references: `${fk.references.table}.${fk.references.column}`, n });
  }

  const others = contract.columns.filter((c) => c.name !== contract.primaryKey).map((c) => ident(c.name));
  const { n: contentDuplicates } = await duck.one<{ n: number }>(
    `select (count(*) - count(distinct (${others.join(", ")})))::integer as n from ${table}`,
  );

  let lagDays: TableQuality["lagDays"] = null;
  if (stagedRows > 0 && contract.eventTime && contract.processDate) {
    const lag = `datediff('day', cast(${ident(contract.eventTime)} as date), ${ident(contract.processDate)})`;
    lagDays = await duck.one<{ avg: number; min: number; max: number }>(
      `select round(avg(${lag}), 2) as avg, min(${lag})::integer as min, max(${lag})::integer as max from ${table}`,
    );
  }

  return {
    table: contract.table,
    stagedRows,
    documentedRows: contract.documentedRows,
    rejectsByReason,
    nullRates,
    orphans,
    contentDuplicates,
    lagDays,
  };
}

/**
 * Aggregates stg._load_log across every run that has ever loaded at least one file for a
 * table, so load statistics survive beyond the current process (unlike the in-memory
 * StageResult[] returned by a single run).
 */
export async function loadHistory(duck: Duck): Promise<LoadHistoryRow[]> {
  const rows = await duck.all<{
    table_name: string;
    files_loaded: number;
    rows_read: number;
    rejected: number;
    duplicates_in_batch: number;
    inserted: number;
    updated: number;
    missing_columns: string | null;
    unexpected_columns: string | null;
  }>(`
    select table_name, files_loaded::integer as files_loaded, rows_read::integer as rows_read,
      rejected::integer as rejected, duplicates_in_batch::integer as duplicates_in_batch,
      inserted::integer as inserted, updated::integer as updated, missing_columns, unexpected_columns
    from stg._load_log
    order by table_name, loaded_at`);

  const byTable = new Map<string, LoadHistoryRow>();
  for (const r of rows) {
    const row = byTable.get(r.table_name) ?? {
      table: r.table_name,
      filesLoaded: 0,
      rowsRead: 0,
      rejected: 0,
      duplicatesInBatch: 0,
      inserted: 0,
      updated: 0,
      missingColumns: [],
      unexpectedColumns: [],
    };
    row.filesLoaded += r.files_loaded;
    row.rowsRead += r.rows_read;
    row.rejected += r.rejected;
    row.duplicatesInBatch += r.duplicates_in_batch;
    row.inserted += r.inserted;
    row.updated += r.updated;
    for (const col of (r.missing_columns ?? "").split(",").filter(Boolean)) {
      if (!row.missingColumns.includes(col)) row.missingColumns.push(col);
    }
    for (const col of (r.unexpected_columns ?? "").split(",").filter(Boolean)) {
      if (!row.unexpectedColumns.includes(col)) row.unexpectedColumns.push(col);
    }
    byTable.set(r.table_name, row);
  }
  return [...byTable.values()];
}

export function renderQualityMarkdown(
  quality: readonly TableQuality[],
  history: readonly LoadHistoryRow[],
  runId: string,
): string {
  const load = mdTable(
    history.map((s) => ({
      table: s.table,
      files_loaded: s.filesLoaded,
      rows_read: s.rowsRead,
      rejected: s.rejected,
      duplicates_in_batch: s.duplicatesInBatch,
      inserted: s.inserted,
      updated: s.updated,
      missing_columns: s.missingColumns.join(", ") || "-",
      unexpected_columns: s.unexpectedColumns.join(", ") || "-",
    })),
  );
  const tables = quality.map((q) => {
    const delta = q.documentedRows
      ? `${(((q.stagedRows - q.documentedRows) / q.documentedRows) * 100).toFixed(1)}%`
      : "n/a";
    const lag = q.lagDays
      ? `- Arrival lag (process_date - event date, days): avg ${q.lagDays.avg}, min ${q.lagDays.min}, max ${q.lagDays.max}\n`
      : "";
    return [
      `## ${q.table}\n`,
      `- Staged rows: ${q.stagedRows} (documented: ${q.documentedRows}, delta: ${delta})`,
      `- Content-level duplicates (same values, different key): ${q.contentDuplicates}`,
      `${lag}`,
      `### Rejects by reason\n\n${mdTable(q.rejectsByReason)}`,
      `### Null rates (nullable columns, %)\n\n${mdTable(q.nullRates)}`,
      `### Orphaned foreign keys\n\n${mdTable(q.orphans)}`,
    ].join("\n");
  });
  return `# Data quality report\n\nRun: \`${runId}\`\n\n## Load summary (all runs)\n\n${load}\n${tables.join("\n")}`;
}
