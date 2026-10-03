export function mdTable(rows: readonly Record<string, unknown>[]): string {
  const first = rows[0];
  if (!first) return "_none_\n";
  const keys = Object.keys(first);
  const line = (cells: readonly unknown[]) => `| ${cells.map((c) => String(c ?? "")).join(" | ")} |`;
  return `${[line(keys), line(keys.map(() => "---")), ...rows.map((r) => line(keys.map((k) => r[k])))].join("\n")}\n`;
}
