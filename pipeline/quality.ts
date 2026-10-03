import type { Contract } from "./contracts/types";
import type { Duck } from "./duck";
import { mdTable } from "./markdown";
import { ident, lit } from "./sql";
import type { StageResult } from "./stage";

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
  if (contract.eventTime && contract.processDate) {
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

export function renderQualityMarkdown(
  quality: readonly TableQuality[],
  stages: readonly StageResult[],
  runId: string,
): string {
  const load = mdTable(
    stages.map((s) => ({
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
  return `# Data quality report\n\nRun: \`${runId}\`\n\n## Load summary (this run)\n\n${load}\n${tables.join("\n")}`;
}
