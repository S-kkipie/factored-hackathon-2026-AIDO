import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import postgres from "postgres";
import { ROOT } from "../../pipeline/config";

export type Param = string | number | boolean | null | Uint8Array;

/**
 * The one database seam of the server: Postgres (Supabase) in production, PGlite (in-process Postgres) in tests and
 * local development. Statements use `$1..$n` placeholders; tables are always schema-qualified (`ops.`, `serving.`)
 * so no session-level search_path is needed (Supabase's transaction pooler does not keep one).
 */
export interface Sql {
  all<T>(text: string, params?: readonly Param[]): Promise<T[]>;
  one<T>(text: string, params?: readonly Param[]): Promise<T | null>;
  /** Runs a statement and returns the number of affected rows. */
  run(text: string, params?: readonly Param[]): Promise<number>;
  /** Multi-statement script without parameters (migrations, seeds). */
  exec(text: string): Promise<void>;
  /** Runs `fn` in one transaction; `fn` must use the `Sql` it receives, never the outer one. */
  tx<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");

/** The Supabase migrations, in order. They are idempotent, so applying them at startup is safe. */
export function migrationSql(dir = MIGRATIONS_DIR): string {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

export async function migrate(sql: Sql): Promise<void> {
  await sql.exec(migrationSql());
}

// ── Postgres (postgres.js) ──────────────────────────────────────────────────────────────────────────────────

type PgClient = postgres.Sql | postgres.TransactionSql;

function wrapPg(client: PgClient, root: postgres.Sql | null): Sql {
  const query = (text: string, params: readonly Param[] = []) =>
    client.unsafe(text, params as postgres.ParameterOrJSON<never>[]);
  return {
    all: async <T>(text: string, params?: readonly Param[]) => [...(await query(text, params))] as T[],
    one: async <T>(text: string, params?: readonly Param[]) => ((await query(text, params))[0] as T | undefined) ?? null,
    run: async (text, params) => (await query(text, params)).count,
    exec: async (text) => {
      await client.unsafe(text).simple();
    },
    tx: async <T>(fn: (sql: Sql) => Promise<T>) => {
      if (!root) throw new Error("nested transactions are not supported");
      return (await root.begin((t) => fn(wrapPg(t, null)))) as T;
    },
    close: async () => {
      await root?.end({ timeout: 5 });
    },
  };
}

/**
 * Connects to Postgres. `prepare: false` keeps it compatible with Supabase's transaction pooler (port 6543);
 * the session pooler and direct connections work as well.
 */
export function openPostgres(url: string, max = 10): Sql {
  const client = postgres(url, {
    max,
    prepare: false,
    onnotice: () => {},
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : "require",
  });
  return wrapPg(client, client);
}

// ── PGlite ──────────────────────────────────────────────────────────────────────────────────────────────────

function wrapPglite(db: PGlite | Transaction, root: PGlite | null): Sql {
  return {
    all: async <T>(text: string, params?: readonly Param[]) => (await db.query<T>(text, params as unknown[])).rows,
    one: async <T>(text: string, params?: readonly Param[]) => (await db.query<T>(text, params as unknown[])).rows[0] ?? null,
    run: async (text, params) => (await db.query(text, params as unknown[])).affectedRows ?? 0,
    exec: async (text) => {
      await db.exec(text);
    },
    tx: async <T>(fn: (sql: Sql) => Promise<T>) => {
      if (!root) throw new Error("nested transactions are not supported");
      return root.transaction((t) => fn(wrapPglite(t, null)));
    },
    close: async () => {
      await root?.close();
    },
  };
}

export const fromPglite = (db: PGlite): Sql => wrapPglite(db, db);

/** In-process Postgres: in memory when `dataDir` is omitted, persisted to disk otherwise. */
export async function openPglite(dataDir?: string): Promise<Sql> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite(dataDir);
  await db.waitReady;
  return fromPglite(db);
}

/** `DATABASE_URL` set → Postgres (Supabase); otherwise a PGlite database under `pgliteDir`. Migrations applied. */
export async function openDatabase(opts: { databaseUrl: string | null; pgliteDir: string }): Promise<Sql> {
  const sql = opts.databaseUrl ? openPostgres(opts.databaseUrl) : await openPglite(opts.pgliteDir);
  await migrate(sql);
  return sql;
}
