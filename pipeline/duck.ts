import { DuckDBInstance } from "@duckdb/node-api";

export interface Duck {
  run(sql: string): Promise<void>;
  all<T = Record<string, unknown>>(sql: string): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string): Promise<T>;
  close(): void;
}

export async function openDuck(path: string): Promise<Duck> {
  const instance = await DuckDBInstance.create(path);
  const conn = await instance.connect();
  const all = async <T>(sql: string): Promise<T[]> => {
    const reader = await conn.runAndReadAll(sql);
    return reader.getRowObjectsJson() as T[];
  };
  return {
    async run(sql) {
      await conn.run(sql);
    },
    all,
    async one<T>(sql: string) {
      const [row] = await all<T>(sql);
      if (row === undefined) throw new Error(`query returned no rows: ${sql.slice(0, 120)}`);
      return row;
    },
    close() {
      conn.closeSync();
      instance.closeSync();
    },
  };
}
