/** Quote a value as a SQL string literal. */
export const lit = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** Quote a SQL identifier. */
export const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;
