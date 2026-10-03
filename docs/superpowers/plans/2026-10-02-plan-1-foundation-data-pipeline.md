# Plan 1 — Foundation & Data Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reproducible `bun run pipeline` that mirrors the organizer S3 data, validates it against data contracts, stages it incrementally with dedup and lineage, and produces `serving.sqlite` (app subset with demo personas), demand marts, a data-quality report, and a run manifest.

**Architecture:** TypeScript on Bun. DuckDB (`@duckdb/node-api`) is the processing engine over local CSV mirrors; a persistent DuckDB warehouse holds staging tables (`stg.*`) plus load bookkeeping. Contracts are TS objects compiled into SQL validation; curation writes SQLite through DuckDB's `sqlite` extension. Every module is a small function with an explicit interface, tested against tiny CSV fixtures.

**Tech Stack:** Bun 1.3, TypeScript, `@duckdb/node-api` 1.5, `bun:sqlite`, Bun `S3Client`, `bun test`, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-02-banking-cs-system-design.md` (sections 2, 5, 8 CI/CD, 10)

This is plan 1 of 6. Later plans: 2 core service (auth, tools, policy, graph, trace, API), 3 ML router, 4 web UI, 5 evaluation harness, 6 deploy & ops.

## Global Constraints

- All code, identifiers, comments, docs in English.
- Runtime is Bun; no Python in the repository.
- Simulated clock `2026-06-17`; serving window 180 days; persona "recent" window 90 days.
- Policy thresholds used for persona selection: auto-dispute max `amount_usd` = 500; fraud threshold `fraud_score` ≥ 30.
- Serving subset ≈ 2,000 customers stratified by country × segment, deterministic with seed 42.
- Never commit: `data/`, `.env`, organizer documents, `serving.sqlite`. S3 credentials only in `.env` (gitignored).
- LLM-bound and serving data excludes document numbers, emails, phones, addresses; card/account numbers masked to last 4.
- DuckDB returns BIGINT as strings in JSON rows: always cast counts with `::integer` in SQL.

## File Structure

| Path | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `.env.example`, `.github/workflows/ci.yml` | Project scaffold, scripts, CI |
| `pipeline/config.ts` | Paths and run parameters (`PipelineConfig`, `defaultConfig`) |
| `pipeline/sql.ts` | SQL literal/identifier quoting |
| `pipeline/duck.ts` | Thin DuckDB wrapper (`Duck`, `openDuck`) |
| `pipeline/markdown.ts` | Markdown table rendering |
| `pipeline/download.ts` | S3 mirror (`ObjectStore`, `bunS3Store`, `mirror`) + CLI |
| `pipeline/contracts/types.ts` | Contract types + `col` helper |
| `pipeline/contracts/{customers,products,transactions,complaints,call_center_interactions}.ts` | One contract per table |
| `pipeline/contracts/index.ts` | `CONTRACTS` in load order |
| `pipeline/validate.ts` | Contract → typed SELECT with reject reasons |
| `pipeline/stage.ts` | Incremental staging: file tracking, rejects, dedup, upsert |
| `pipeline/curate.ts` | Personas, stratified subset, `serving.sqlite` |
| `pipeline/marts.ts` | Demand marts → parquet + markdown |
| `pipeline/quality.ts` | Quality metrics + markdown report |
| `pipeline/manifest.ts` | Fingerprints, git sha, manifest JSON |
| `pipeline/run.ts` | Orchestrator + CLI (`runPipeline`) |
| `tests/pipeline/fixtures/raw/**` | Tiny hive-partitioned CSV fixtures |
| `tests/pipeline/helpers.ts` | Temp workspace + stage-all helpers |
| `tests/pipeline/*.test.ts` | Unit and end-to-end tests |

---

### Task 1: Project scaffold and DuckDB wrapper

**Files:**
- Create: `package.json`, `tsconfig.json`, `.env.example`, `.github/workflows/ci.yml`
- Create: `pipeline/config.ts`, `pipeline/sql.ts`, `pipeline/duck.ts`, `pipeline/markdown.ts`
- Delete: `scripts/download.py`
- Test: `tests/pipeline/duck.test.ts`

**Interfaces:**
- Produces: `PipelineConfig`, `defaultConfig(overrides?)`, `ROOT`; `lit(s)`, `ident(name)`; `Duck { run, all<T>, one<T>, close }`, `openDuck(path)`; `mdTable(rows)`.

- [ ] **Step 1: Create the scaffold**

`package.json`:
```json
{
  "name": "factored-hackathon-2026-aido",
  "private": true,
  "type": "module",
  "scripts": {
    "download": "bun pipeline/download.ts",
    "pipeline": "bun pipeline/run.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  }
}
```

Then install dependencies:
```bash
bun add @duckdb/node-api
bun add -d typescript @types/bun
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "lib": ["ESNext"],
    "types": ["bun"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["pipeline", "tests"]
}
```

`.env.example`:
```bash
# Organizer S3 (read-only). Values are in the organizer data dictionary; never commit .env.
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_REGION=us-east-2
S3_BUCKET=factored-datathon-2026-s3-157725502942-us-east-2-an
```

`.github/workflows/ci.yml`:
```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun test
```

Delete the Python script: `git rm scripts/download.py`

- [ ] **Step 2: Write the failing test**

`tests/pipeline/duck.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { openDuck } from "../../pipeline/duck";
import { mdTable } from "../../pipeline/markdown";
import { ident, lit } from "../../pipeline/sql";

describe("sql quoting", () => {
  test("lit escapes single quotes", () => {
    expect(lit("O'Brien")).toBe("'O''Brien'");
  });
  test("ident escapes double quotes", () => {
    expect(ident('a"b')).toBe('"a""b"');
  });
});

describe("openDuck", () => {
  test("runs statements and returns JSON rows", async () => {
    const duck = await openDuck(":memory:");
    await duck.run("create table t (id varchar, n integer); insert into t values ('a', 1), ('b', 2)");
    expect(await duck.all("select id, n from t order by id")).toEqual([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ]);
    expect(await duck.one<{ total: number }>("select sum(n)::integer as total from t")).toEqual({ total: 3 });
    duck.close();
  });
  test("one() throws when the query returns no rows", async () => {
    const duck = await openDuck(":memory:");
    await expect(duck.one("select 1 where false")).rejects.toThrow("no rows");
    duck.close();
  });
});

describe("mdTable", () => {
  test("renders a markdown table", () => {
    expect(mdTable([{ a: 1, b: null }])).toBe("| a | b |\n| --- | --- |\n| 1 |  |\n");
  });
  test("renders a placeholder for empty input", () => {
    expect(mdTable([])).toBe("_none_\n");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/pipeline/duck.test.ts`
Expected: FAIL, cannot resolve `../../pipeline/duck`.

- [ ] **Step 4: Implement**

`pipeline/config.ts`:
```ts
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");

export interface PipelineConfig {
  rawDir: string;
  warehousePath: string;
  servingPath: string;
  martsDir: string;
  reportsDir: string;
  runsDir: string;
  /** Simulated "today" (last date in the dataset). */
  clock: string;
  /** Transactions kept in serving.sqlite, counted back from the clock. */
  windowDays: number;
  /** Window used to qualify demo personas. */
  recentDays: number;
  subsetSize: number;
  seed: number;
  /** Synthetic policy: largest amount eligible for automatic dispute intake. */
  maxAutoUsd: number;
  /** Synthetic policy: fraud_score at or above this requires a human. */
  fraudScore: number;
}

export function defaultConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    rawDir: join(ROOT, "data/raw"),
    warehousePath: join(ROOT, "data/warehouse.duckdb"),
    servingPath: join(ROOT, "data/serving.sqlite"),
    martsDir: join(ROOT, "data/marts"),
    reportsDir: join(ROOT, "reports"),
    runsDir: join(ROOT, "data/runs"),
    clock: "2026-06-17",
    windowDays: 180,
    recentDays: 90,
    subsetSize: 2000,
    seed: 42,
    maxAutoUsd: 500,
    fraudScore: 30,
    ...overrides,
  };
}
```

`pipeline/sql.ts`:
```ts
/** Quote a value as a SQL string literal. */
export const lit = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** Quote a SQL identifier. */
export const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;
```

`pipeline/duck.ts`:
```ts
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
```

`pipeline/markdown.ts`:
```ts
export function mdTable(rows: readonly Record<string, unknown>[]): string {
  const first = rows[0];
  if (!first) return "_none_\n";
  const keys = Object.keys(first);
  const line = (cells: readonly unknown[]) => `| ${cells.map((c) => String(c ?? "")).join(" | ")} |`;
  return `${[line(keys), line(keys.map(() => "---")), ...rows.map((r) => line(keys.map((k) => r[k])))].join("\n")}\n`;
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test tests/pipeline/duck.test.ts && bun run typecheck`
Expected: all tests PASS, typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock tsconfig.json .env.example .github pipeline tests
git commit -m "chore: scaffold Bun project with DuckDB wrapper and CI"
```

---

### Task 2: S3 mirror

**Files:**
- Create: `pipeline/download.ts`
- Test: `tests/pipeline/download.test.ts`

**Interfaces:**
- Produces: `RemoteObject { key: string; size: number }`, `ObjectStore { list(prefix): AsyncIterable<RemoteObject>; download(key, dest): Promise<void> }`, `bunS3Store(): ObjectStore`, `mirror(store, tables, rawDir, concurrency?): Promise<MirrorResult[]>`, `MirrorResult { table: string; total: number; downloaded: number }`, `DEFAULT_TABLES`.

- [ ] **Step 1: Write the failing test**

`tests/pipeline/download.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ObjectStore, mirror } from "../../pipeline/download";

function fakeStore(objects: Record<string, string>): ObjectStore & { downloads: string[] } {
  const downloads: string[] = [];
  return {
    downloads,
    async *list(prefix) {
      for (const [key, body] of Object.entries(objects)) {
        if (key.startsWith(prefix)) yield { key, size: body.length };
      }
    },
    async download(key, dest) {
      downloads.push(key);
      await Bun.write(dest, objects[key] ?? "");
    },
  };
}

describe("mirror", () => {
  test("downloads new objects, keeps the hive layout, skips identical files", async () => {
    const rawDir = await mkdtemp(join(tmpdir(), "aido-mirror-"));
    const store = fakeStore({
      "data/customers.csv": "abc",
      "data/customers.csv.bak": "zzz",
      "data/complaints/year=2026/month=06/day=10/complaints_20260610.csv": "xy",
    });

    const first = await mirror(store, ["customers.csv", "complaints"], rawDir);
    expect(first).toEqual([
      { table: "customers.csv", total: 1, downloaded: 1 },
      { table: "complaints", total: 1, downloaded: 1 },
    ]);
    expect(await readFile(join(rawDir, "customers.csv"), "utf8")).toBe("abc");
    expect(await readFile(join(rawDir, "complaints/year=2026/month=06/day=10/complaints_20260610.csv"), "utf8")).toBe("xy");

    const second = await mirror(store, ["customers.csv", "complaints"], rawDir);
    expect(second.map((r) => r.downloaded)).toEqual([0, 0]);
    expect(store.downloads).not.toContain("data/customers.csv.bak");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/pipeline/download.test.ts`
Expected: FAIL, cannot resolve `../../pipeline/download`.

- [ ] **Step 3: Implement**

`pipeline/download.ts`:
```ts
import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { S3Client } from "bun";
import { defaultConfig } from "./config";

export interface RemoteObject {
  key: string;
  size: number;
}

export interface ObjectStore {
  list(prefix: string): AsyncIterable<RemoteObject>;
  download(key: string, dest: string): Promise<void>;
}

export interface MirrorResult {
  table: string;
  total: number;
  downloaded: number;
}

/** Tables consumed by the pipeline. Names ending in .csv are single files; others are partitioned folders. */
export const DEFAULT_TABLES = [
  "customers.csv",
  "products.csv",
  "transactions",
  "complaints",
  "call_center_interactions",
] as const;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable ${name} (see .env.example)`);
  return value;
}

export function bunS3Store(): ObjectStore {
  const client = new S3Client({
    bucket: required("S3_BUCKET"),
    region: process.env.S3_REGION ?? "us-east-2",
    accessKeyId: required("S3_ACCESS_KEY_ID"),
    secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
  });
  return {
    async *list(prefix) {
      let token: string | undefined;
      do {
        const page = await client.list({ prefix, continuationToken: token });
        for (const o of page.contents ?? []) yield { key: o.key, size: o.size ?? 0 };
        token = page.isTruncated ? page.nextContinuationToken : undefined;
      } while (token);
    },
    async download(key, dest) {
      await mkdir(dirname(dest), { recursive: true });
      await Bun.write(dest, client.file(key));
    },
  };
}

const destFor = (rawDir: string, key: string) => join(rawDir, key.replace(/^data\//, ""));
const localSize = (path: string) => (existsSync(path) ? statSync(path).size : -1);

export async function mirror(
  store: ObjectStore,
  tables: readonly string[],
  rawDir: string,
  concurrency = 16,
): Promise<MirrorResult[]> {
  const results: MirrorResult[] = [];
  for (const table of tables) {
    const isFile = table.endsWith(".csv");
    const prefix = isFile ? `data/${table}` : `data/${table}/`;
    const objects: RemoteObject[] = [];
    for await (const o of store.list(prefix)) {
      if (!isFile || o.key === prefix) objects.push(o);
    }
    const todo = objects.filter((o) => localSize(destFor(rawDir, o.key)) !== o.size);
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const o = todo[next++];
        if (o) await store.download(o.key, destFor(rawDir, o.key));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
    results.push({ table, total: objects.length, downloaded: todo.length });
  }
  return results;
}

if (import.meta.main) {
  const tables = process.argv.length > 2 ? process.argv.slice(2) : [...DEFAULT_TABLES];
  const results = await mirror(bunS3Store(), tables, defaultConfig().rawDir);
  for (const r of results) console.log(`${r.table}: ${r.downloaded} downloaded / ${r.total} remote`);
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/pipeline/download.test.ts && bun run typecheck`
Expected: PASS, typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add pipeline/download.ts tests/pipeline/download.test.ts
git commit -m "feat(pipeline): add idempotent S3 mirror"
```

---

### Task 3: Data contracts and validation SQL

**Files:**
- Create: `pipeline/contracts/types.ts`, `pipeline/contracts/customers.ts`, `pipeline/contracts/products.ts`, `pipeline/contracts/transactions.ts`, `pipeline/contracts/complaints.ts`, `pipeline/contracts/call_center_interactions.ts`, `pipeline/contracts/index.ts`, `pipeline/validate.ts`
- Test: `tests/pipeline/validate.test.ts`

**Interfaces:**
- Consumes: `openDuck`, `lit`, `ident` (Task 1).
- Produces: `ColumnType`, `Column`, `ForeignKey`, `Contract`, `col(name, type, nullable?, extra?)`; contracts `customers`, `products`, `transactions`, `complaints`, `callCenterInteractions`; `CONTRACTS` (load order: customers, products, transactions, complaints, call_center_interactions); `typedSelectSql(contract, presentColumns): string`. The SELECT reads from a table named `_batch` (alias `raw`, all VARCHAR columns plus `source_file`) and outputs typed contract columns, `_reasons` (`''` when valid, otherwise `;`-joined codes `type:<col>`, `null:<col>`, `enum:<col>` in column order), and `source_file`.

- [ ] **Step 1: Write the failing test**

`tests/pipeline/validate.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { CONTRACTS } from "../../pipeline/contracts";
import { type Contract, col } from "../../pipeline/contracts/types";
import { openDuck } from "../../pipeline/duck";
import { typedSelectSql } from "../../pipeline/validate";

const contract: Contract = {
  table: "t",
  files: "t.csv",
  primaryKey: "id",
  documentedRows: 0,
  columns: [
    col("id", "VARCHAR"),
    col("amount", "DOUBLE"),
    col("status", "VARCHAR", false, { enum: ["A", "B"] }),
    col("country", "VARCHAR", true, { normalize: "case when {v} = 'Mexico' then 'México' else {v} end" }),
  ],
};

describe("typedSelectSql", () => {
  test("casts, normalizes and lists reject reasons in column order", async () => {
    const duck = await openDuck(":memory:");
    await duck.run(`create temp table _batch as select * from (values
      ('1', '10.5', 'A', 'Mexico', 'f1'),
      ('2', 'abc', 'A', ' ', 'f1'),
      (null, '1', 'Z', 'Peru', 'f2')
    ) v(id, amount, status, country, source_file)`);
    const sql = typedSelectSql(contract, new Set(["id", "amount", "status", "country"]));
    const rows = await duck.all(`select * from (${sql}) order by id nulls last`);
    expect(rows).toEqual([
      { id: "1", amount: 10.5, status: "A", country: "México", _reasons: "", source_file: "f1" },
      { id: "2", amount: null, status: "A", country: null, _reasons: "type:amount", source_file: "f1" },
      { id: null, amount: 1, status: "Z", country: "Peru", _reasons: "null:id;enum:status", source_file: "f2" },
    ]);
    duck.close();
  });

  test("treats columns absent from the batch as null", async () => {
    const duck = await openDuck(":memory:");
    await duck.run(`create temp table _batch as select * from (values ('1', '2', 'B', 'f1')) v(id, amount, status, source_file)`);
    const rows = await duck.all(`${typedSelectSql(contract, new Set(["id", "amount", "status"]))}`);
    expect(rows).toEqual([{ id: "1", amount: 2, status: "B", country: null, _reasons: "", source_file: "f1" }]);
    duck.close();
  });
});

describe("CONTRACTS", () => {
  test("primary keys and foreign keys reference declared columns and tables", () => {
    const tables = new Map(CONTRACTS.map((c) => [c.table, c]));
    for (const c of CONTRACTS) {
      const names = new Set(c.columns.map((x) => x.name));
      expect(names.has(c.primaryKey)).toBe(true);
      for (const fk of c.foreignKeys ?? []) {
        expect(names.has(fk.column)).toBe(true);
        const parent = tables.get(fk.references.table);
        expect(parent?.columns.some((x) => x.name === fk.references.column)).toBe(true);
      }
    }
  });
  test("load order puts parents before children", () => {
    expect(CONTRACTS.map((c) => c.table)).toEqual([
      "customers",
      "products",
      "transactions",
      "complaints",
      "call_center_interactions",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/pipeline/validate.test.ts`
Expected: FAIL, cannot resolve `../../pipeline/contracts`.

- [ ] **Step 3: Implement contract types**

`pipeline/contracts/types.ts`:
```ts
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
```

- [ ] **Step 4: Implement the five contracts**

Enum values are the values observed in the data (Spanish where the source is Spanish) plus the values documented in the data dictionary.

`pipeline/contracts/customers.ts`:
```ts
import { type Contract, col } from "./types";

export const customers: Contract = {
  table: "customers",
  files: "customers.csv",
  primaryKey: "customer_id",
  documentedRows: 150_000,
  columns: [
    col("customer_id", "VARCHAR"),
    col("document_type", "VARCHAR", false, { enum: ["DNI", "CURP", "CC", "CE", "Passport", "Pasaporte"] }),
    col("first_name", "VARCHAR"),
    col("last_name", "VARCHAR"),
    col("country", "VARCHAR", false, { enum: ["Argentina", "Colombia", "México"] }),
    col("segment", "VARCHAR", false, { enum: ["Premium", "Plus", "Basic", "Student"] }),
    col("customer_status", "VARCHAR", false, { enum: ["Active", "Inactive", "Suspended", "Closed"] }),
    col("detected_accent", "VARCHAR", true, { enum: ["mexican", "colombian", "argentine", "neutral"] }),
    col("registration_date", "TIMESTAMP"),
    col("last_updated", "TIMESTAMP"),
  ],
};
```

`pipeline/contracts/products.ts`:
```ts
import { type Contract, col } from "./types";

export const products: Contract = {
  table: "products",
  files: "products.csv",
  primaryKey: "product_id",
  documentedRows: 400_000,
  columns: [
    col("product_id", "VARCHAR"),
    col("customer_id", "VARCHAR"),
    col("product_type", "VARCHAR", false, {
      enum: [
        "Cuenta Ahorro",
        "Cuenta Corriente",
        "Tarjeta Crédito",
        "Tarjeta Débito",
        "Préstamo Personal",
        "Préstamo Hipotecario",
        "Inversión",
        "Seguro",
      ],
    }),
    col("product_number", "VARCHAR"),
    col("currency", "VARCHAR", false, { enum: ["MXN", "COP", "ARS", "USD"] }),
    col("current_balance", "DOUBLE"),
    col("credit_limit", "DOUBLE", true),
    col("product_status", "VARCHAR", false, { enum: ["Active", "Blocked", "Closed", "Suspended"] }),
    col("opening_date", "DATE"),
    col("last_updated", "TIMESTAMP"),
  ],
  foreignKeys: [{ column: "customer_id", references: { table: "customers", column: "customer_id" } }],
};
```

`pipeline/contracts/transactions.ts`:
```ts
import { type Contract, col } from "./types";

export const transactions: Contract = {
  table: "transactions",
  files: "transactions/**/*.csv",
  primaryKey: "transaction_id",
  documentedRows: 5_000_000,
  eventTime: "transaction_date",
  processDate: "process_date",
  columns: [
    col("transaction_id", "VARCHAR"),
    col("transaction_date", "TIMESTAMP"),
    col("process_date", "DATE"),
    col("product_id", "VARCHAR"),
    col("customer_id", "VARCHAR"),
    col("transaction_type", "VARCHAR", false, {
      enum: ["Deposit", "Withdrawal", "Transfer", "Payment", "Purchase", "Adjustment"],
    }),
    col("transaction_category", "VARCHAR", true, {
      enum: ["Food", "Transport", "Services", "Entertainment", "Health", "Other"],
    }),
    col("amount", "DOUBLE"),
    col("currency", "VARCHAR", false, { enum: ["MXN", "COP", "ARS", "USD"] }),
    col("amount_usd", "DOUBLE", true),
    col("channel", "VARCHAR", false, { enum: ["ATM", "Branch", "Web", "App", "POS", "Transfer"] }),
    col("merchant_name", "VARCHAR", true),
    col("merchant_category", "VARCHAR", true),
    col("transaction_country", "VARCHAR", false, {
      normalize: "case when {v} = 'Mexico' then 'México' else {v} end",
    }),
    col("transaction_city", "VARCHAR", true),
    col("transaction_status", "VARCHAR", false, { enum: ["Approved", "Declined", "Pending", "Reversed"] }),
    col("response_code", "VARCHAR", true),
    col("is_fraud", "BOOLEAN"),
    col("fraud_score", "DOUBLE", true),
  ],
  foreignKeys: [
    { column: "product_id", references: { table: "products", column: "product_id" } },
    { column: "customer_id", references: { table: "customers", column: "customer_id" } },
  ],
};
```

`pipeline/contracts/complaints.ts`:
```ts
import { type Contract, col } from "./types";

export const complaints: Contract = {
  table: "complaints",
  files: "complaints/**/*.csv",
  primaryKey: "complaint_id",
  documentedRows: 80_000,
  eventTime: "creation_date",
  processDate: "process_date",
  columns: [
    col("complaint_id", "VARCHAR"),
    col("creation_date", "TIMESTAMP"),
    col("process_date", "DATE"),
    col("customer_id", "VARCHAR"),
    col("case_type", "VARCHAR", false, { enum: ["Complaint", "Claim", "Request", "Suggestion"] }),
    col("category", "VARCHAR", false, { enum: ["Transactions", "Fees", "Technical", "Branch", "Service"] }),
    col("subcategory", "VARCHAR", true, {
      enum: [
        "Cargo no reconocido",
        "Cobro indebido",
        "Problema con app",
        "Atención en sucursal",
        "Calidad de servicio",
      ],
    }),
    col("reception_channel", "VARCHAR", false, {
      enum: ["Call Center", "Email", "Web", "App", "Branch", "Regulator"],
    }),
    col("affected_product_id", "VARCHAR", true),
    col("description", "VARCHAR"),
    col("claimed_amount", "DOUBLE", true),
    col("currency", "VARCHAR", true, { enum: ["MXN", "COP", "ARS", "USD"] }),
    col("priority", "VARCHAR", false, { enum: ["Low", "Medium", "High", "Critical"] }),
    col("status", "VARCHAR", false, {
      enum: ["Open", "In Process", "Escalated", "Resolved", "Closed", "Rejected"],
    }),
    col("sla_breached", "BOOLEAN"),
    col("resolution_days", "INTEGER", true),
    col("resolution_satisfaction", "INTEGER", true),
    col("is_repeat_complainer", "BOOLEAN"),
  ],
  foreignKeys: [
    { column: "customer_id", references: { table: "customers", column: "customer_id" } },
    { column: "affected_product_id", references: { table: "products", column: "product_id" } },
  ],
};
```

`pipeline/contracts/call_center_interactions.ts`:
```ts
import { type Contract, col } from "./types";

export const callCenterInteractions: Contract = {
  table: "call_center_interactions",
  files: "call_center_interactions/**/*.csv",
  primaryKey: "interaction_id",
  documentedRows: 800_000,
  eventTime: "interaction_date",
  processDate: "process_date",
  columns: [
    col("interaction_id", "VARCHAR"),
    col("interaction_date", "TIMESTAMP"),
    col("process_date", "DATE"),
    col("customer_id", "VARCHAR"),
    col("channel", "VARCHAR", false, { enum: ["Phone", "Web Chat", "WhatsApp", "Email", "App", "Web"] }),
    col("reason_category", "VARCHAR", false, {
      enum: ["Transaccional", "Producto", "Queja", "Técnico", "Comercial", "Retención"],
    }),
    col("duration_seconds", "DOUBLE", true),
    col("wait_time_seconds", "DOUBLE", true),
    col("was_resolved", "BOOLEAN", true),
    col("was_escalated", "BOOLEAN"),
    col("detected_sentiment", "VARCHAR", true, {
      enum: ["Muy Negativo", "Negativo", "Neutral", "Positivo", "Muy Positivo"],
    }),
  ],
  foreignKeys: [{ column: "customer_id", references: { table: "customers", column: "customer_id" } }],
};
```

`pipeline/contracts/index.ts`:
```ts
import { callCenterInteractions } from "./call_center_interactions";
import { complaints } from "./complaints";
import { customers } from "./customers";
import { products } from "./products";
import { transactions } from "./transactions";
import type { Contract } from "./types";

/** Load order: parents before children. */
export const CONTRACTS: readonly Contract[] = [customers, products, transactions, complaints, callCenterInteractions];

export { callCenterInteractions, complaints, customers, products, transactions };
```

- [ ] **Step 5: Implement validation SQL**

`pipeline/validate.ts`:
```ts
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
```

- [ ] **Step 6: Run tests and typecheck**

Run: `bun test tests/pipeline/validate.test.ts && bun run typecheck`
Expected: PASS, typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add pipeline/contracts pipeline/validate.ts tests/pipeline/validate.test.ts
git commit -m "feat(pipeline): add data contracts and validation SQL"
```

---

### Task 4: Fixtures and incremental staging

**Files:**
- Create: `tests/pipeline/fixtures/raw/customers.csv`, `tests/pipeline/fixtures/raw/products.csv`, `tests/pipeline/fixtures/raw/transactions/year=2026/month=06/day=10/transactions_20260610.csv`, `tests/pipeline/fixtures/raw/transactions/year=2026/month=06/day=11/transactions_20260611.csv`, `tests/pipeline/fixtures/raw/complaints/year=2026/month=06/day=10/complaints_20260610.csv`, `tests/pipeline/fixtures/raw/call_center_interactions/year=2026/month=06/day=10/call_center_interactions_20260610.csv`
- Create: `tests/pipeline/helpers.ts`, `pipeline/stage.ts`
- Test: `tests/pipeline/stage.test.ts`

**Interfaces:**
- Consumes: `Duck`, `openDuck`, `lit`, `ident`, `Contract`, `CONTRACTS`, `typedSelectSql`, `PipelineConfig`, `defaultConfig`.
- Produces: `SourceFile { path: string; size: number }`; `StageResult { table; filesLoaded; rowsRead; rejected; duplicatesInBatch; inserted; updated; missingColumns: string[]; unexpectedColumns: string[] }`; `ensureStagingSchema(duck)`; `listSourceFiles(rawDir, pattern): Promise<SourceFile[]>`; `stageTable(duck, contract, files, rawDir, loadId): Promise<StageResult>`. Staging tables live in schema `stg` with the contract columns plus `source_file` (path relative to rawDir) and `load_id`; bookkeeping tables `stg._loaded_files(table_name, source_file, size, load_id)` and `stg._rejects(table_name, pk, reasons, source_file, load_id)`.
- Test helpers: `makeWorkspace(): Promise<PipelineConfig>`, `stageAll(duck, config, loadId): Promise<StageResult[]>`, `TX_HEADER`.

Load semantics (state these in the code comment): a file is (re)loaded when its relative path is new or its size changed; within a batch the row from the lexically latest file wins (partition paths are zero-padded dates); across batches the most recently loaded row wins (`insert or replace`).

- [ ] **Step 1: Create the fixtures**

`tests/pipeline/fixtures/raw/customers.csv`:
```csv
customer_id,document_type,first_name,last_name,country,segment,customer_status,detected_accent,registration_date,last_updated
C1,Pasaporte,Ana,Lopez,México,Basic,Active,mexican,2024-01-01 10:00:00,2026-06-01 10:00:00
C2,CC,Juan,Perez,Colombia,Plus,Suspended,colombian,2024-02-01 10:00:00,2026-06-01 10:00:00
C3,DNI,Sofia,Gomez,Argentina,Premium,Active,,2024-03-01 10:00:00,2026-06-01 10:00:00
C4,DNI,Bad,Row,Argentina,Gold,Active,argentine,2024-03-01 10:00:00,2026-06-01 10:00:00
```

`tests/pipeline/fixtures/raw/products.csv`:
```csv
product_id,customer_id,product_type,product_number,currency,current_balance,credit_limit,product_status,opening_date,last_updated
P1,C1,Tarjeta Crédito,4111111111111111,USD,1200.50,5000,Active,2024-01-02,2026-06-01 10:00:00
P2,C2,Cuenta Ahorro,1234567890,COP,3500000,,Active,2024-02-02,2026-06-01 10:00:00
P3,C3,Tarjeta Débito,5222222222222222,ARS,800000,,Active,2024-03-02,2026-06-01 10:00:00
P9,C9,Cuenta Ahorro,9999,USD,10,,Active,2024-03-02,2026-06-01 10:00:00
```

`tests/pipeline/fixtures/raw/transactions/year=2026/month=06/day=10/transactions_20260610.csv`:
```csv
transaction_id,transaction_date,process_date,product_id,customer_id,transaction_type,transaction_category,amount,currency,amount_usd,channel,merchant_name,merchant_category,transaction_country,transaction_city,transaction_status,response_code,is_fraud,fraud_score
T1,2026-06-10 12:00:00,2026-06-10,P1,C1,Purchase,Food,45.00,USD,,POS,Super Ahorro,Food,Mexico,CDMX,Approved,00,False,12.5
T2,2026-06-10 13:00:00,2026-06-10,P1,C1,Purchase,Other,300.00,USD,,Web,Boutique Moda,Other,México,CDMX,Approved,00,False,88.0
T3,2026-06-10 14:00:00,2026-06-10,P3,C3,Purchase,Entertainment,900000,ARS,950.00,POS,Teatro Nacional,Entertainment,Argentina,Buenos Aires,Approved,00,False,5.0
T4,2026-06-10 15:00:00,2026-06-10,P2,C2,Withdrawal,,200000,COP,48.00,ATM,,,Colombia,Bogotá,Approved,00,False,3.0
TX,not-a-date,2026-06-10,P1,C1,Purchase,Food,10,USD,,POS,Super Ahorro,Food,México,CDMX,Approved,00,False,1.0
```

`tests/pipeline/fixtures/raw/transactions/year=2026/month=06/day=11/transactions_20260611.csv`:
```csv
transaction_id,transaction_date,process_date,product_id,customer_id,transaction_type,transaction_category,amount,currency,amount_usd,channel,merchant_name,merchant_category,transaction_country,transaction_city,transaction_status,response_code,is_fraud,fraud_score
T1,2026-06-10 12:00:00,2026-06-11,P1,C1,Purchase,Food,45.00,USD,,POS,Super Ahorro,Food,Mexico,CDMX,Reversed,00,False,12.5
T5,2025-01-05 09:00:00,2026-06-11,P1,C1,Purchase,Health,20.00,USD,,POS,Farmacia Salud,Health,México,CDMX,Approved,00,False,2.0
T6,2026-06-11 09:00:00,2026-06-11,P1,C1,Purchase,Health,30.00,USD,,POS,Farmacia Salud,Health,México,CDMX,Approved,00,False,4.0
```

`tests/pipeline/fixtures/raw/complaints/year=2026/month=06/day=10/complaints_20260610.csv`:
```csv
complaint_id,creation_date,process_date,customer_id,case_type,category,subcategory,reception_channel,affected_product_id,description,claimed_amount,currency,priority,status,sla_breached,resolution_days,resolution_satisfaction,is_repeat_complainer
Q1,2026-06-10 10:00:00,2026-06-10,C3,Complaint,Transactions,Cargo no reconocido,App,P3,Queja relacionada con transactions,950,USD,High,Open,False,,,True
Q2,2026-06-10 11:00:00,2026-06-10,C1,Claim,Fees,Cobro indebido,Call Center,P1,Queja relacionada con fees,15,USD,Low,Resolved,True,20,3,False
```

`tests/pipeline/fixtures/raw/call_center_interactions/year=2026/month=06/day=10/call_center_interactions_20260610.csv`:
```csv
interaction_id,interaction_date,process_date,customer_id,channel,reason_category,duration_seconds,wait_time_seconds,was_resolved,was_escalated,detected_sentiment
I1,2026-06-10 09:00:00,2026-06-10,C1,Phone,Transaccional,200.0,120.0,True,False,Neutral
I2,2026-06-10 09:30:00,2026-06-10,C2,Phone,Queja,450.0,110.0,False,True,Negativo
I3,2026-06-10 10:00:00,2026-06-10,C3,WhatsApp,Transaccional,,130.0,True,False,Positivo
```

- [ ] **Step 2: Write the test helpers**

`tests/pipeline/helpers.ts`:
```ts
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PipelineConfig, defaultConfig } from "../../pipeline/config";
import { CONTRACTS } from "../../pipeline/contracts";
import type { Duck } from "../../pipeline/duck";
import { type StageResult, listSourceFiles, stageTable } from "../../pipeline/stage";

export const TX_HEADER =
  "transaction_id,transaction_date,process_date,product_id,customer_id,transaction_type,transaction_category,amount,currency,amount_usd,channel,merchant_name,merchant_category,transaction_country,transaction_city,transaction_status,response_code,is_fraud,fraud_score";

/** Copy the fixtures into a fresh temp directory and return a config pointing at it. */
export async function makeWorkspace(): Promise<PipelineConfig> {
  const dir = await mkdtemp(join(tmpdir(), "aido-pipeline-"));
  await cp(join(import.meta.dir, "fixtures/raw"), join(dir, "raw"), { recursive: true });
  return defaultConfig({
    rawDir: join(dir, "raw"),
    warehousePath: join(dir, "warehouse.duckdb"),
    servingPath: join(dir, "serving.sqlite"),
    martsDir: join(dir, "marts"),
    reportsDir: join(dir, "reports"),
    runsDir: join(dir, "runs"),
  });
}

export async function stageAll(duck: Duck, config: PipelineConfig, loadId: string): Promise<StageResult[]> {
  const results: StageResult[] = [];
  for (const contract of CONTRACTS) {
    const files = await listSourceFiles(config.rawDir, contract.files);
    results.push(await stageTable(duck, contract, files, config.rawDir, loadId));
  }
  return results;
}
```

- [ ] **Step 3: Write the failing test**

`tests/pipeline/stage.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { customers, transactions } from "../../pipeline/contracts";
import { openDuck } from "../../pipeline/duck";
import { ensureStagingSchema, listSourceFiles, stageTable } from "../../pipeline/stage";
import { TX_HEADER, makeWorkspace } from "./helpers";

describe("stageTable", () => {
  test("loads valid rows and quarantines contract violations", async () => {
    const config = await makeWorkspace();
    const duck = await openDuck(":memory:");
    await ensureStagingSchema(duck);
    const files = await listSourceFiles(config.rawDir, customers.files);
    const result = await stageTable(duck, customers, files, config.rawDir, "load-1");
    expect(result).toMatchObject({ filesLoaded: 1, rowsRead: 4, rejected: 1, inserted: 3, updated: 0 });
    expect(await duck.all("select pk, reasons, source_file from stg._rejects")).toEqual([
      { pk: "C4", reasons: "enum:segment", source_file: "customers.csv" },
    ]);
    duck.close();
  });

  test("dedups within a batch (latest file wins) and normalizes values", async () => {
    const config = await makeWorkspace();
    const duck = await openDuck(":memory:");
    await ensureStagingSchema(duck);
    const files = await listSourceFiles(config.rawDir, transactions.files);
    const result = await stageTable(duck, transactions, files, config.rawDir, "load-1");
    expect(result).toMatchObject({
      filesLoaded: 2,
      rowsRead: 8,
      rejected: 1,
      duplicatesInBatch: 1,
      inserted: 6,
      updated: 0,
      missingColumns: [],
      unexpectedColumns: [],
    });
    expect(
      await duck.one<Record<string, unknown>>(
        "select transaction_status, transaction_country, source_file, load_id from stg.transactions where transaction_id = 'T1'",
      ),
    ).toEqual({
      transaction_status: "Reversed",
      transaction_country: "México",
      source_file: "transactions/year=2026/month=06/day=11/transactions_20260611.csv",
      load_id: "load-1",
    });
    expect(await duck.all("select pk, reasons from stg._rejects")).toEqual([
      { pk: "TX", reasons: "type:transaction_date" },
    ]);
    duck.close();
  });

  test("incremental: unchanged files are skipped; late partitions and corrections are applied", async () => {
    const config = await makeWorkspace();
    const duck = await openDuck(":memory:");
    await ensureStagingSchema(duck);
    await stageTable(duck, transactions, await listSourceFiles(config.rawDir, transactions.files), config.rawDir, "load-1");

    const rerun = await stageTable(
      duck,
      transactions,
      await listSourceFiles(config.rawDir, transactions.files),
      config.rawDir,
      "load-2",
    );
    expect(rerun.filesLoaded).toBe(0);

    // Labeled fixture: a late-arriving older partition (new row T7) and a correction to T2.
    await Bun.write(
      join(config.rawDir, "transactions/year=2026/month=06/day=09/transactions_20260609.csv"),
      `${TX_HEADER}\nT7,2026-06-09 08:00:00,2026-06-09,P3,C3,Payment,Services,1000,ARS,1.05,App,Internet Plus,Services,Argentina,Rosario,Approved,00,False,1.0\n`,
    );
    await Bun.write(
      join(config.rawDir, "transactions/year=2026/month=06/day=12/transactions_20260612.csv"),
      `${TX_HEADER}\nT2,2026-06-10 13:00:00,2026-06-12,P1,C1,Purchase,Other,300.00,USD,,Web,Boutique Moda,Other,México,CDMX,Reversed,00,False,88.0\n`,
    );
    const late = await stageTable(
      duck,
      transactions,
      await listSourceFiles(config.rawDir, transactions.files),
      config.rawDir,
      "load-3",
    );
    expect(late).toMatchObject({ filesLoaded: 2, rowsRead: 2, inserted: 1, updated: 1 });
    expect(await duck.one<Record<string, unknown>>("select count(*)::integer as n from stg.transactions")).toEqual({ n: 7 });
    expect(
      await duck.one<Record<string, unknown>>("select transaction_status, load_id from stg.transactions where transaction_id = 'T2'"),
    ).toEqual({ transaction_status: "Reversed", load_id: "load-3" });
    duck.close();
  });

  test("reports schema drift", async () => {
    const config = await makeWorkspace();
    await Bun.write(
      join(config.rawDir, "customers.csv"),
      "customer_id,document_type,first_name,last_name,country,segment,customer_status,registration_date,last_updated,favorite_color\nC1,DNI,Ana,Lopez,México,Basic,Active,2024-01-01 10:00:00,2026-06-01 10:00:00,blue\n",
    );
    const duck = await openDuck(":memory:");
    await ensureStagingSchema(duck);
    const result = await stageTable(
      duck,
      customers,
      await listSourceFiles(config.rawDir, customers.files),
      config.rawDir,
      "load-1",
    );
    expect(result.missingColumns).toEqual(["detected_accent"]);
    expect(result.unexpectedColumns).toEqual(["favorite_color"]);
    expect(result.inserted).toBe(1);
    duck.close();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test tests/pipeline/stage.test.ts`
Expected: FAIL, cannot resolve `../../pipeline/stage`.

- [ ] **Step 5: Implement staging**

`pipeline/stage.ts`:
```ts
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
      table_name varchar, pk varchar, reasons varchar, source_file varchar, load_id varchar);`);
}

export async function listSourceFiles(rawDir: string, pattern: string): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  for await (const rel of new Bun.Glob(pattern).scan({ cwd: rawDir })) {
    const path = join(rawDir, rel);
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
 * - Across batches, the most recently loaded row wins (insert or replace on the primary key).
 */
export async function stageTable(
  duck: Duck,
  contract: Contract,
  files: readonly SourceFile[],
  rawDir: string,
  loadId: string,
): Promise<StageResult> {
  await duck.run(tableDdl(contract));
  const table = `stg.${ident(contract.table)}`;
  const pk = ident(contract.primaryKey);

  const loaded = await duck.all<{ source_file: string; size: number }>(
    `select source_file, size::double as size from stg._loaded_files where table_name = ${lit(contract.table)}`,
  );
  const known = new Map(loaded.map((r) => [r.source_file, Number(r.size)]));
  const pending = files.filter((f) => known.get(relative(rawDir, f.path)) !== f.size);
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

  const prefix = rawDir.endsWith("/") ? rawDir : `${rawDir}/`;
  await duck.run(`create or replace temp table _batch as
    select * exclude (filename), replace(filename, ${lit(prefix)}, '') as source_file
    from read_csv([${pending.map((f) => lit(f.path)).join(", ")}],
      all_varchar = true, union_by_name = true, filename = true, hive_partitioning = false)`);

  const batchColumns = (await duck.all<{ column_name: string }>("select column_name from (describe _batch)"))
    .map((r) => r.column_name)
    .filter((name) => name !== "source_file");
  const present = new Set(batchColumns);
  const declared = new Set(contract.columns.map((c) => c.name));
  result.missingColumns = [...declared].filter((name) => !present.has(name));
  result.unexpectedColumns = batchColumns.filter((name) => !declared.has(name));

  await duck.run(`create or replace temp table _typed as ${typedSelectSql(contract, present)}`);
  await duck.run(`insert into stg._rejects
    select ${lit(contract.table)}, cast(${pk} as varchar), _reasons, source_file, ${lit(loadId)}
    from _typed where _reasons <> ''`);
  await duck.run(`create or replace temp table _clean as
    select * exclude (_reasons) from _typed where _reasons = ''
    qualify row_number() over (partition by ${pk} order by source_file desc) = 1`);

  const counts = await duck.one<{ rows_read: number; rejected: number; valid: number; clean: number; updated: number }>(
    `select
      (select count(*)::integer from _typed) as rows_read,
      (select count(*)::integer from _typed where _reasons <> '') as rejected,
      (select count(*)::integer from _typed where _reasons = '') as valid,
      (select count(*)::integer from _clean) as clean,
      (select count(*)::integer from _clean n where exists (select 1 from ${table} s where s.${pk} = n.${pk})) as updated`,
  );

  const columns = [...contract.columns.map((c) => ident(c.name)), "source_file"].join(", ");
  await duck.run(`insert or replace into ${table} (${columns}, load_id) select ${columns}, ${lit(loadId)} from _clean`);
  const fileRows = pending
    .map((f) => `(${lit(contract.table)}, ${lit(relative(rawDir, f.path))}, ${f.size}, ${lit(loadId)})`)
    .join(", ");
  await duck.run(`insert or replace into stg._loaded_files values ${fileRows}`);

  result.rowsRead = counts.rows_read;
  result.rejected = counts.rejected;
  result.duplicatesInBatch = counts.valid - counts.clean;
  result.updated = counts.updated;
  result.inserted = counts.clean - counts.updated;
  return result;
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `bun test tests/pipeline/stage.test.ts && bun run typecheck`
Expected: PASS, typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add pipeline/stage.ts tests/pipeline/helpers.ts tests/pipeline/stage.test.ts tests/pipeline/fixtures
git commit -m "feat(pipeline): add incremental staging with rejects, dedup and lineage"
```

---

### Task 5: Curation to serving.sqlite

**Files:**
- Create: `pipeline/curate.ts`
- Test: `tests/pipeline/curate.test.ts`

**Interfaces:**
- Consumes: `Duck`, `lit`, `PipelineConfig`, staged tables `stg.customers|products|transactions|complaints` (Task 4), `makeWorkspace`, `stageAll`.
- Produces: `CurateResult { customers: number; transactions: number; personas: Record<Persona, string> }`, `Persona = "normal" | "high_amount" | "fraud_suspect" | "repeat_complainer" | "suspended"`, `curate(duck, config): Promise<CurateResult>`. `serving.sqlite` tables (consumed by plan 2):
  - `customers(customer_id, first_name, last_name, country, segment, customer_status, detected_accent, source_file, load_id)`
  - `products(product_id, customer_id, product_type, product_number_masked, currency, current_balance, credit_limit, product_status, source_file, load_id)`
  - `transactions(transaction_id, transaction_date, product_id, customer_id, transaction_type, transaction_category, amount, currency, amount_usd, channel, merchant_name, merchant_category, transaction_country, transaction_city, transaction_status, response_code, fraud_score, source_file, load_id)`; `transaction_date` is ISO text; `amount_usd` is filled from `amount` when currency is USD; `is_fraud` is intentionally excluded (label leak; policy uses `fraud_score`).
  - `complaints(complaint_id, customer_id, creation_date, category, subcategory, status, claimed_amount, currency, is_repeat_complainer, affected_product_id, source_file, load_id)`
  - `demo_users(persona, customer_id)`, `meta(key, value)` with keys `clock`, `window_days`, `built_at`.

- [ ] **Step 1: Write the failing test**

`tests/pipeline/curate.test.ts`:
```ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { curate } from "../../pipeline/curate";
import { openDuck } from "../../pipeline/duck";
import { ensureStagingSchema } from "../../pipeline/stage";
import { makeWorkspace, stageAll } from "./helpers";

describe("curate", () => {
  test("builds serving.sqlite with personas, window filter and PII minimization", async () => {
    const config = await makeWorkspace();
    const duck = await openDuck(":memory:");
    await ensureStagingSchema(duck);
    await stageAll(duck, config, "load-1");

    const result = await curate(duck, config);
    duck.close();

    expect(result.personas).toEqual({
      fraud_suspect: "C1",
      high_amount: "C3",
      normal: "C1",
      repeat_complainer: "C3",
      suspended: "C2",
    });
    expect(result).toMatchObject({ customers: 3, transactions: 5 });

    const db = new Database(config.servingPath, { readonly: true });
    const ids = (sql: string) => db.query<{ id: string }, []>(sql).all().map((r) => r.id);
    expect(ids("select customer_id as id from customers order by 1")).toEqual(["C1", "C2", "C3"]);
    expect(ids("select transaction_id as id from transactions order by 1")).toEqual(["T1", "T2", "T3", "T4", "T6"]);
    expect(ids("select product_id as id from products order by 1")).toEqual(["P1", "P2", "P3"]);

    const customerColumns = db.query<{ name: string }, []>("pragma table_info(customers)").all().map((r) => r.name);
    expect(customerColumns).not.toContain("document_type");
    expect(customerColumns).not.toContain("document_number");

    expect(db.query("select product_number_masked as m from products where product_id = 'P1'").get()).toEqual({
      m: "****1111",
    });
    expect(db.query("select amount_usd as usd from transactions where transaction_id = 'T1'").get()).toEqual({
      usd: 45,
    });
    expect(db.query("select value from meta where key = 'clock'").get()).toEqual({ value: "2026-06-17" });
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/pipeline/curate.test.ts`
Expected: FAIL, cannot resolve `../../pipeline/curate`.

- [ ] **Step 3: Implement**

`pipeline/curate.ts`:
```ts
import { rm } from "node:fs/promises";
import type { PipelineConfig } from "./config";
import type { Duck } from "./duck";
import { lit } from "./sql";

export type Persona = "normal" | "high_amount" | "fraud_suspect" | "repeat_complainer" | "suspended";

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

  await rm(o.servingPath, { force: true });
  await duck.run(`install sqlite; load sqlite; attach ${lit(o.servingPath)} as srv (type sqlite)`);
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
    const personaRows = await duck.all<{ persona: Persona; customer_id: string }>(
      "select persona, customer_id from _personas order by persona",
    );
    return {
      ...counts,
      personas: Object.fromEntries(personaRows.map((r) => [r.persona, r.customer_id])) as Record<Persona, string>,
    };
  } finally {
    await duck.run("detach srv");
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/pipeline/curate.test.ts && bun run typecheck`
Expected: PASS, typecheck exits 0. (First run downloads the DuckDB `sqlite` extension; network required.)

- [ ] **Step 5: Commit**

```bash
git add pipeline/curate.ts tests/pipeline/curate.test.ts
git commit -m "feat(pipeline): curate serving.sqlite with demo personas and PII minimization"
```

---

### Task 6: Demand marts and quality report

**Files:**
- Create: `pipeline/marts.ts`, `pipeline/quality.ts`
- Test: `tests/pipeline/quality.test.ts`

**Interfaces:**
- Consumes: `Duck`, `lit`, `ident`, `mdTable`, `Contract`, `CONTRACTS`, `customers`, `products`, `transactions`, `StageResult`, `makeWorkspace`, `stageAll`.
- Produces:
  - `MartRows = Record<string, Record<string, unknown>[]>`; `buildMarts(duck, martsDir): Promise<MartRows>` writing `contact_mix.parquet`, `complaint_mix.parquet`, `monthly_contacts.parquet`; `renderDemandMarkdown(marts): string`.
  - `TableQuality { table; stagedRows; documentedRows; rejectsByReason: { reason: string; n: number }[]; nullRates: { column: string; pct: number }[]; orphans: { column: string; references: string; n: number }[]; contentDuplicates: number; lagDays: { avg: number; min: number; max: number } | null }`; `assessTable(duck, contract): Promise<TableQuality>`; `renderQualityMarkdown(quality, stages, runId): string`.

- [ ] **Step 1: Write the failing test**

`tests/pipeline/quality.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { customers, products, transactions } from "../../pipeline/contracts";
import { openDuck } from "../../pipeline/duck";
import { buildMarts, renderDemandMarkdown } from "../../pipeline/marts";
import { assessTable, renderQualityMarkdown } from "../../pipeline/quality";
import { ensureStagingSchema } from "../../pipeline/stage";
import { makeWorkspace, stageAll } from "./helpers";

async function staged() {
  const config = await makeWorkspace();
  const duck = await openDuck(":memory:");
  await ensureStagingSchema(duck);
  const stages = await stageAll(duck, config, "load-1");
  return { config, duck, stages };
}

describe("assessTable", () => {
  test("reports rejects, nulls, orphans, duplicates and arrival lag", async () => {
    const { duck, stages } = await staged();
    const c = await assessTable(duck, customers);
    expect(c).toMatchObject({
      table: "customers",
      stagedRows: 3,
      documentedRows: 150_000,
      rejectsByReason: [{ reason: "enum:segment", n: 1 }],
      contentDuplicates: 0,
      lagDays: null,
    });
    expect(c.nullRates).toEqual([{ column: "detected_accent", pct: 33.33 }]);

    const p = await assessTable(duck, products);
    expect(p.orphans).toEqual([{ column: "customer_id", references: "customers.customer_id", n: 1 }]);

    const t = await assessTable(duck, transactions);
    expect(t.nullRates).toContainEqual({ column: "transaction_category", pct: 16.67 });
    expect(t.lagDays?.max).toBe(522);

    const md = renderQualityMarkdown([c, p, t], stages, "run-x");
    expect(md).toContain("Run: `run-x`");
    expect(md).toContain("## customers");
    expect(md).toContain("| enum:segment | 1 |");
    duck.close();
  });
});

describe("buildMarts", () => {
  test("writes parquet marts and returns rows", async () => {
    const { config, duck } = await staged();
    const marts = await buildMarts(duck, config.martsDir);
    expect(marts.contact_mix).toEqual([
      { reason_category: "Transaccional", n: 2, pct: 66.7, fcr_pct: 100, escalation_pct: 0, avg_duration_s: 200 },
      { reason_category: "Queja", n: 1, pct: 33.3, fcr_pct: 0, escalation_pct: 100, avg_duration_s: 450 },
    ]);
    expect(existsSync(join(config.martsDir, "contact_mix.parquet"))).toBe(true);
    expect(renderDemandMarkdown(marts)).toContain("## contact_mix");
    duck.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/pipeline/quality.test.ts`
Expected: FAIL, cannot resolve `../../pipeline/marts`.

- [ ] **Step 3: Implement marts**

`pipeline/marts.ts`:
```ts
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Duck } from "./duck";
import { mdTable } from "./markdown";
import { lit } from "./sql";

export type MartRows = Record<string, Record<string, unknown>[]>;

/** Demand evidence used to justify the workflow and as the operational baseline. */
const MARTS: Record<string, string> = {
  contact_mix: `
    select reason_category, count(*)::integer as n,
      round(100.0 * count(*) / sum(count(*)) over (), 1)::double as pct,
      round(100.0 * avg(was_resolved::integer), 1)::double as fcr_pct,
      round(100.0 * avg(was_escalated::integer), 1)::double as escalation_pct,
      round(avg(duration_seconds))::double as avg_duration_s
    from stg.call_center_interactions group by 1 order by n desc, 1`,
  complaint_mix: `
    select category, coalesce(subcategory, '(missing)') as subcategory, count(*)::integer as n,
      round(100.0 * count(*) / sum(count(*)) over (), 1)::double as pct,
      round(100.0 * avg(sla_breached::integer), 1)::double as sla_breach_pct,
      round(avg(resolution_days), 1)::double as avg_resolution_days,
      round(avg(resolution_satisfaction), 2)::double as avg_satisfaction
    from stg.complaints group by 1, 2 order by n desc, 1, 2`,
  monthly_contacts: `
    select strftime(interaction_date, '%Y-%m') as month, reason_category, count(*)::integer as n
    from stg.call_center_interactions group by 1, 2 order by 1, 2`,
};

export async function buildMarts(duck: Duck, martsDir: string): Promise<MartRows> {
  await mkdir(martsDir, { recursive: true });
  const out: MartRows = {};
  for (const [name, sql] of Object.entries(MARTS)) {
    await duck.run(`copy (${sql}) to ${lit(join(martsDir, `${name}.parquet`))} (format parquet)`);
    out[name] = await duck.all(sql);
  }
  return out;
}

export function renderDemandMarkdown(marts: MartRows): string {
  const sections = Object.entries(marts)
    .filter(([name]) => name !== "monthly_contacts")
    .map(([name, rows]) => `## ${name}\n\n${mdTable(rows)}`);
  return `# Demand evidence\n\nSource: staged call_center_interactions and complaints.\n\n${sections.join("\n")}`;
}
```

- [ ] **Step 4: Implement the quality report**

`pipeline/quality.ts`:
```ts
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
```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test tests/pipeline/quality.test.ts && bun run typecheck`
Expected: PASS, typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add pipeline/marts.ts pipeline/quality.ts tests/pipeline/quality.test.ts
git commit -m "feat(pipeline): add demand marts and data quality report"
```

---

### Task 7: Orchestration, manifest, and real run

**Files:**
- Create: `pipeline/manifest.ts`, `pipeline/run.ts`
- Modify: `README.md`
- Create (generated by real run, committed): `reports/quality.md`, `reports/demand.md`
- Test: `tests/pipeline/run.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `fingerprint(files, rawDir): string`, `sha256File(path): Promise<string>`, `gitSha(): string | null`, `Manifest`, `writeManifest(runsDir, manifest): Promise<string>`; `RunSummary { runId; stages: StageResult[]; quality: TableQuality[]; personas: Record<Persona, string>; manifestPath: string }`, `runPipeline(config): Promise<RunSummary>`.

- [ ] **Step 1: Write the failing test**

`tests/pipeline/run.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runPipeline } from "../../pipeline/run";
import { makeWorkspace } from "./helpers";

describe("runPipeline", () => {
  test("runs end to end, writes reports and manifest, and is idempotent", async () => {
    const config = await makeWorkspace();
    const first = await runPipeline(config);

    expect(first.stages.map((s) => s.table)).toEqual([
      "customers",
      "products",
      "transactions",
      "complaints",
      "call_center_interactions",
    ]);
    expect(first.personas.normal).toBe("C1");

    const quality = await readFile(join(config.reportsDir, "quality.md"), "utf8");
    expect(quality).toContain(`Run: \`${first.runId}\``);
    expect(await readFile(join(config.reportsDir, "demand.md"), "utf8")).toContain("## contact_mix");

    const manifest = JSON.parse(await readFile(first.manifestPath, "utf8"));
    expect(manifest.runId).toBe(first.runId);
    expect(manifest.inputs.transactions.files).toBe(2);
    expect(manifest.inputs.transactions.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.outputs.serving.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.outputs.serving.customers).toBe(3);

    const second = await runPipeline(config);
    expect(second.stages.every((s) => s.filesLoaded === 0)).toBe(true);
    expect(second.personas).toEqual(first.personas);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/pipeline/run.test.ts`
Expected: FAIL, cannot resolve `../../pipeline/run`.

- [ ] **Step 3: Implement the manifest**

`pipeline/manifest.ts`:
```ts
import { mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { StageResult, SourceFile } from "./stage";

export interface Manifest {
  runId: string;
  startedAt: string;
  finishedAt: string;
  gitSha: string | null;
  parameters: Record<string, string | number>;
  inputs: Record<string, { files: number; fingerprint: string }>;
  stages: StageResult[];
  outputs: { serving: { path: string; sha256: string; customers: number; transactions: number } };
}

/** Stable fingerprint of an input set: sha256 over sorted "relative-path:size" lines. */
export function fingerprint(files: readonly SourceFile[], rawDir: string): string {
  const lines = files
    .map((f) => `${relative(rawDir, f.path)}:${f.size}`)
    .sort()
    .join("\n");
  return new Bun.CryptoHasher("sha256").update(lines).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  return new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex");
}

export function gitSha(): string | null {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"]);
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

export async function writeManifest(runsDir: string, manifest: Manifest): Promise<string> {
  const dir = join(runsDir, manifest.runId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "manifest.json");
  await Bun.write(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}
```

- [ ] **Step 4: Implement the orchestrator**

`pipeline/run.ts`:
```ts
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type PipelineConfig, defaultConfig } from "./config";
import { CONTRACTS } from "./contracts";
import { type Persona, curate } from "./curate";
import { openDuck } from "./duck";
import { fingerprint, gitSha, sha256File, writeManifest } from "./manifest";
import { buildMarts, renderDemandMarkdown } from "./marts";
import { type TableQuality, assessTable, renderQualityMarkdown } from "./quality";
import { type StageResult, ensureStagingSchema, listSourceFiles, stageTable } from "./stage";

export interface RunSummary {
  runId: string;
  stages: StageResult[];
  quality: TableQuality[];
  personas: Record<Persona, string>;
  manifestPath: string;
}

export async function runPipeline(config: PipelineConfig): Promise<RunSummary> {
  const startedAt = new Date().toISOString();
  const runId = `${startedAt.replace(/[-:]/g, "").replace(/\..*$/, "")}-${crypto.randomUUID().slice(0, 8)}`;
  await mkdir(dirname(config.warehousePath), { recursive: true });
  await mkdir(config.reportsDir, { recursive: true });

  const duck = await openDuck(config.warehousePath);
  try {
    await ensureStagingSchema(duck);
    const stages: StageResult[] = [];
    const inputs: Record<string, { files: number; fingerprint: string }> = {};
    for (const contract of CONTRACTS) {
      const files = await listSourceFiles(config.rawDir, contract.files);
      inputs[contract.table] = { files: files.length, fingerprint: fingerprint(files, config.rawDir) };
      stages.push(await stageTable(duck, contract, files, config.rawDir, runId));
    }

    const curated = await curate(duck, config);
    const marts = await buildMarts(duck, config.martsDir);
    const quality: TableQuality[] = [];
    for (const contract of CONTRACTS) quality.push(await assessTable(duck, contract));

    await Bun.write(join(config.reportsDir, "quality.md"), renderQualityMarkdown(quality, stages, runId));
    await Bun.write(join(config.reportsDir, "demand.md"), renderDemandMarkdown(marts));

    const manifestPath = await writeManifest(config.runsDir, {
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      gitSha: gitSha(),
      parameters: {
        clock: config.clock,
        windowDays: config.windowDays,
        recentDays: config.recentDays,
        subsetSize: config.subsetSize,
        seed: config.seed,
        maxAutoUsd: config.maxAutoUsd,
        fraudScore: config.fraudScore,
      },
      inputs,
      stages,
      outputs: {
        serving: {
          path: config.servingPath,
          sha256: await sha256File(config.servingPath),
          customers: curated.customers,
          transactions: curated.transactions,
        },
      },
    });
    return { runId, stages, quality, personas: curated.personas, manifestPath };
  } finally {
    duck.close();
  }
}

if (import.meta.main) {
  const summary = await runPipeline(defaultConfig());
  console.table(summary.stages);
  console.log("personas:", summary.personas);
  console.log("manifest:", summary.manifestPath);
}
```

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: all pipeline tests PASS, typecheck exits 0.

- [ ] **Step 6: Commit the orchestrator**

```bash
git add pipeline/manifest.ts pipeline/run.ts tests/pipeline/run.test.ts
git commit -m "feat(pipeline): add run orchestration and manifest"
```

- [ ] **Step 7: Run against the real dataset**

Requires `.env` with the organizer S3 credentials (copy `.env.example`, fill the two keys).

Run:
```bash
bun run download
bun run pipeline
```
Expected:
- Download reports totals for 5 tables; files already mirrored are skipped.
- The pipeline prints the stage table and 5 personas (one customer id each).
- Staged row counts match `docs/data_findings.md`: customers 150,000; transactions 4,425,008; complaints 67,095; call_center_interactions 686,296.
- `reports/demand.md` contact_mix shows Transaccional 35.0% and Queja 17.1%.
- `reports/quality.md` shows `transaction_country` normalization in effect (no `Mexico` in staged data) and the rejects/nulls/orphans per table.

If any count disagrees with `docs/data_findings.md`, stop and investigate before committing (most likely a contract enum missing a real value: check `stg._rejects` reasons in `reports/quality.md`).

- [ ] **Step 8: Update the README**

Replace the "Data access" section of `README.md` with:
````markdown
## Setup

Requires [Bun](https://bun.sh) 1.3+.

```bash
bun install
cp .env.example .env   # fill in the organizer S3 credentials (never commit .env)
bun run download       # mirror the dataset into data/raw (idempotent)
bun run pipeline       # contracts → staging → serving.sqlite, marts, reports
bun test
```

Pipeline outputs:
- `data/serving.sqlite`: customer subset and demo personas used by the app (not committed).
- `data/marts/*.parquet`: demand evidence.
- `reports/quality.md`, `reports/demand.md`: data quality and demand reports (committed).
- `data/runs/<run_id>/manifest.json`: lineage (input fingerprints, per-stage counts, output hash).
````

- [ ] **Step 9: Commit reports and README**

```bash
git add README.md reports/quality.md reports/demand.md
git commit -m "docs: add pipeline setup and first data quality and demand reports"
```

---

## Self-Review

- **Spec coverage (sections 2, 5, 8 CI/CD, 10):** S3 mirror (T2); contracts with types/nullability/enums/PK/FK (T3); rejects with reasons (T3, T4); dedup incl. content-level (T4, T6); incremental watermark by file with labeled late-partition + correction fixture (T4); lineage `source_file`/`load_id` + manifest with input hashes and per-stage counts (T4, T7); serving subset ~2,000 stratified + 5 personas (T5); PII minimization (T5); demand marts (T6); quality report incl. documented vs found, nulls, orphans, lag, schema drift (T4, T6); CI (T1); reproducible setup (T7); restricted data never committed (Global Constraints, `.gitignore`). Spec items for plans 2–6 are out of scope here.
- **Placeholder scan:** none.
- **Type consistency:** `StageResult`, `SourceFile`, `Persona`, `CurateResult`, `TableQuality`, `MartRows`, `RunSummary` names match across tasks; `curate(duck, config)` accepts the full `PipelineConfig` (structural `Pick`).
