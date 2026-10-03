export type ColumnType = "VARCHAR" | "INTEGER" | "DOUBLE" | "BOOLEAN" | "DATE" | "TIMESTAMP";

export interface Column {
  name: string;
  type: ColumnType;
  nullable: boolean;
  enum?: readonly string[];
  /** SQL applied to the raw (trimmed, empty-as-null) value before casting; `{v}` is replaced by that value. */
  normalize?: string;
}

export interface ForeignKey {
  column: string;
  references: { table: string; column: string };
}

/**
 * Consumer-driven contract: only the columns the system consumes.
 * Columns present in the source but absent here are reported as unexpected (schema drift), not loaded.
 */
export interface Contract {
  table: string;
  /** Glob relative to the raw directory. */
  files: string;
  primaryKey: string;
  columns: readonly Column[];
  foreignKeys?: readonly ForeignKey[];
  /** Row count stated in the organizer data dictionary. */
  documentedRows: number;
  eventTime?: string;
  processDate?: string;
}

export const col = (
  name: string,
  type: ColumnType,
  nullable = false,
  extra: Pick<Column, "enum" | "normalize"> = {},
): Column => ({ name, type, nullable, ...extra });
