import type { Column, Contract } from "./contracts/types";
import { ident, lit } from "./sql";

/** Raw value expression for a column: trimmed, empty as null, normalized; null literal if the column is absent. */
export function rawValue(column: Column, present: ReadonlySet<string>): string {
  const base = present.has(column.name)
    ? `nullif(trim(raw.${ident(column.name)}), '')`
    : "cast(null as varchar)";
  return column.normalize ? column.normalize.replaceAll("{v}", base) : base;
}

function checks(column: Column, value: string): string[] {
  const out = [
    `case when ${value} is not null and try_cast(${value} as ${column.type}) is null then 'type:${column.name}' end`,
  ];
  if (!column.nullable) out.push(`case when ${value} is null then 'null:${column.name}' end`);
  if (column.enum) {
    const allowed = column.enum.map(lit).join(", ");
    out.push(`case when ${value} is not null and ${value} not in (${allowed}) then 'enum:${column.name}' end`);
  }
  return out;
}

/** SELECT over `_batch raw` producing typed contract columns, `_reasons` ('' when valid) and `source_file`. */
export function typedSelectSql(contract: Contract, present: ReadonlySet<string>): string {
  const values = contract.columns.map((column) => [column, rawValue(column, present)] as const);
  const select = values
    .map(([column, value]) => `try_cast(${value} as ${column.type}) as ${ident(column.name)}`)
    .join(",\n  ");
  const reasons = values.flatMap(([column, value]) => checks(column, value)).join(",\n    ");
  return `select\n  ${select},\n  coalesce(concat_ws(';',\n    ${reasons}), '') as _reasons,\n  raw.source_file as source_file\nfrom _batch raw`;
}
