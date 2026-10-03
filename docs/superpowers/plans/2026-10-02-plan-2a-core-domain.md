# Plan 2a — Core Domain (auth, data access, tools, policy, gates) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fully unit-tested, framework-free core for the banking agent: provenance-typed values, read-only serving data access, operational store, hash-chained audit log, JWT sessions, ownership-checked tools with timeouts/retries/idempotency, the policy engine, and the deterministic gates (input, budget, risk, nonce, schema, response).

**Architecture:** Plain TypeScript modules under `server/` with no HTTP and no LLM. Every module takes its dependencies (databases, clock) as arguments so tests use in-memory or temp SQLite. Plan 2b wires these into the LangGraph graph and the Elysia API.

**Tech Stack:** Bun 1.3, TypeScript, `bun:sqlite`, `jose` 6 (JWT HS256), `@sinclair/typebox` 0.34, `bun test`.

**Spec:** `docs/superpowers/specs/2026-10-02-banking-cs-system-design.md` (sections 3.2, 3.3, 4.3, 4.5, 8)

Depends on plan 1 only for the `serving.sqlite` schema (tests build their own fixture). Plan 2a of 6 (2a core, 2b graph + API, 3 ML router, 4 web UI, 5 eval + red team, 6 deploy + ops).

## Global Constraints

- All code, identifiers, comments, docs in English; customer-facing text is Spanish/Portuguese and is produced in plan 2b, not here.
- No Python. Runtime Bun; SQLite only through `bun:sqlite`.
- `customer_id` used by any tool must come from the JWT (`src: "jwt"`); records used to act (transactions in a dispute) must come from the database (`src: "db"`). Violations throw `ProvenanceError` with rule `PROV_001`.
- No tool moves money, blocks cards, or approves credit. Tools only read, create dispute cases, and create handoffs.
- Synthetic policy values (labeled as such): clock `2026-06-17`; auto-dispute max `amount_usd` 250 (real purchases are capped at USD 500, so 250 splits them about 50/50); `fraud_score` ≥ 30 escalates; dispute age ≤ 90 days; ≥ 3 transactions in one dispute escalates; risk score ≥ 3 escalates.
- Budgets: 30 turns, 3 LLM calls per turn, 40,000 tokens per session, USD 5 daily spend.
- Every gate and policy outcome carries a rule id with the prefixes `IN_`, `BUD_`, `RT_`, `SC_`, `POL_`, `PROV_`, `TL_`, `VF_`, `RS_`.
- IDs in data: customers `CLI-…`, products `PRD-…`, transactions `TRX-…`, complaints `CMP-…`; this system creates disputes `D-…` and handoffs `H-…`.

## File Structure

| Path | Responsibility |
|---|---|
| `server/config.ts` | Environment → `ServerConfig` |
| `server/policy/config.ts` | `Policy`, `POLICY`, `Budgets`, `BUDGETS` (synthetic, versioned) |
| `server/provenance.ts` | `Source`, `Val<T>`, `val`, `trusted`, `ProvenanceError` |
| `server/hash.ts` | `sha256Hex` |
| `server/db/serving.ts` | Read-only queries over `serving.sqlite` |
| `server/db/ops.ts` | `ops.sqlite` schema/migrations |
| `server/audit.ts` | Hash-chained audit log |
| `server/auth.ts` | Demo login, agent login, JWT issue/verify, sessions |
| `server/tools/runtime.ts` | `runTool` (timeout, bounded retries), `ToolError` |
| `server/tools/index.ts` | Ownership- and provenance-checked tools |
| `server/policy/rules.ts` | `decide()` pure policy engine |
| `server/gates/pii.ts` | PII detection/masking (cards with Luhn, CPF, CURP, ID docs, email, phone) |
| `server/gates/input.ts` | Input gate: empty, size, rate limit, PII masking |
| `server/gates/budget.ts` | Session/daily budgets, per-turn call counter, circuit breaker |
| `server/gates/risk.ts` | Session risk score |
| `server/gates/nonce.ts` | Single-use confirmation nonces |
| `server/gates/schema.ts` | TypeBox validation with bounded retry |
| `server/gates/response.ts` | Response gate (amounts, ids, commitments, canary, PII, language) |
| `tests/server/fixtures.ts` | Temp `serving.sqlite` + in-memory `ops` builders |
| `tests/server/*.test.ts` | Unit tests |

---

### Task 1: Server config, policy constants, provenance

**Files:**
- Modify: `package.json` (dependencies), `tsconfig.json` (`include`)
- Create: `server/config.ts`, `server/policy/config.ts`, `server/provenance.ts`, `server/hash.ts`
- Test: `tests/server/provenance.test.ts`

**Interfaces:**
- Produces: `ServerConfig`, `loadServerConfig(env?)`; `Policy`, `POLICY`, `Budgets`, `BUDGETS`; `Source`, `Val<T>`, `val(v, src)`, `trusted(field, value, allowed?)`, `ProvenanceError { ruleId; field; src }`; `sha256Hex(text)`.

- [ ] **Step 1: Add dependencies and include `server` in typecheck**

```bash
bun add jose @sinclair/typebox
```
In `tsconfig.json` change `"include": ["pipeline", "tests"]` to `"include": ["pipeline", "server", "tests"]`.

- [ ] **Step 2: Write the failing test**

`tests/server/provenance.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { loadServerConfig } from "../../server/config";
import { sha256Hex } from "../../server/hash";
import { ProvenanceError, trusted, val } from "../../server/provenance";

describe("trusted", () => {
  test("returns the value when the source is allowed", () => {
    expect(trusted("customerId", val("CLI-A", "jwt"))).toBe("CLI-A");
    expect(trusted("tx", val("TRX-1", "db"))).toBe("TRX-1");
  });
  test("throws PROV_001 for model- or user-sourced identity values", () => {
    expect(() => trusted("customerId", val("CLI-B", "llm"))).toThrow(ProvenanceError);
    try {
      trusted("customerId", val("CLI-B", "user"), ["jwt"]);
    } catch (e) {
      expect(e).toBeInstanceOf(ProvenanceError);
      expect((e as ProvenanceError).ruleId).toBe("PROV_001");
      expect((e as ProvenanceError).field).toBe("customerId");
    }
  });
  test("can restrict to a single source", () => {
    expect(() => trusted("customerId", val("CLI-A", "db"), ["jwt"])).toThrow("PROV_001");
  });
});

describe("loadServerConfig", () => {
  test("requires a 32+ character JWT secret", () => {
    expect(() => loadServerConfig({ JWT_SECRET: "short" })).toThrow("JWT_SECRET");
    const cfg = loadServerConfig({ JWT_SECRET: "x".repeat(32), SAFE_MODE: "1" });
    expect(cfg.safeMode).toBe(true);
    expect(cfg.sessionTtlSeconds).toBe(900);
  });
});

describe("sha256Hex", () => {
  test("hashes deterministically", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/server/provenance.test.ts`
Expected: FAIL, cannot resolve `../../server/config`.

- [ ] **Step 4: Implement**

`server/hash.ts`:
```ts
export const sha256Hex = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex");
```

`server/provenance.ts`:
```ts
/** Where a value came from. Only `jwt` and `db` values may identify a customer or a record to act on. */
export type Source = "jwt" | "db" | "user" | "llm";

export interface Val<T> {
  readonly v: T;
  readonly src: Source;
}

export const val = <T>(v: T, src: Source): Val<T> => ({ v, src });

export class ProvenanceError extends Error {
  readonly ruleId = "PROV_001";
  constructor(
    readonly field: string,
    readonly src: Source,
  ) {
    super(`PROV_001: ${field} has untrusted source '${src}'`);
  }
}

export function trusted<T>(field: string, value: Val<T>, allowed: readonly Source[] = ["jwt", "db"]): T {
  if (!allowed.includes(value.src)) throw new ProvenanceError(field, value.src);
  return value.v;
}
```

`server/policy/config.ts`:
```ts
/** Synthetic team policy. Every report labels these values as synthetic. */
export interface Policy {
  version: string;
  /** Simulated "today": last date in the dataset. */
  clock: string;
  maxAutoUsd: number;
  fraudScore: number;
  maxDisputeAgeDays: number;
  maxTxPerDispute: number;
  riskEscalate: number;
}

export const POLICY: Policy = {
  version: "2026-10-02.1",
  clock: "2026-06-17",
  maxAutoUsd: 250,
  fraudScore: 30,
  maxDisputeAgeDays: 90,
  maxTxPerDispute: 2,
  riskEscalate: 3,
};

export interface Budgets {
  maxTurns: number;
  maxLlmCallsPerTurn: number;
  maxTokensPerSession: number;
  dailySpendUsd: number;
}

export const BUDGETS: Budgets = {
  maxTurns: 30,
  maxLlmCallsPerTurn: 3,
  maxTokensPerSession: 40_000,
  dailySpendUsd: 5,
};
```

`server/config.ts`:
```ts
import { join } from "node:path";
import { ROOT } from "../pipeline/config";

export interface ServerConfig {
  servingPath: string;
  opsPath: string;
  jwtSecret: Uint8Array;
  sessionTtlSeconds: number;
  demoPin: string;
  agentPin: string;
  /** Kill switch: no model calls at all, templates and escalation only. */
  safeMode: boolean;
}

export function loadServerConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const secret = env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error("JWT_SECRET must be set to at least 32 characters");
  return {
    servingPath: env.SERVING_PATH ?? join(ROOT, "data/serving.sqlite"),
    opsPath: env.OPS_PATH ?? join(ROOT, "data/ops.sqlite"),
    jwtSecret: new TextEncoder().encode(secret),
    sessionTtlSeconds: 15 * 60,
    demoPin: env.DEMO_PIN ?? "2468",
    agentPin: env.AGENT_PIN ?? "1357",
    safeMode: env.SAFE_MODE === "1",
  };
}
```

Append to `.env.example`:
```bash
# Server
JWT_SECRET=
DEMO_PIN=2468
AGENT_PIN=1357
SAFE_MODE=0
```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test tests/server/provenance.test.ts && bun run typecheck`
Expected: PASS, typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock tsconfig.json .env.example server tests/server
git commit -m "feat(server): add config, synthetic policy constants and provenance types"
```

---

### Task 2: Serving and ops databases

**Files:**
- Create: `server/db/serving.ts`, `server/db/ops.ts`, `tests/server/fixtures.ts`
- Test: `tests/server/db.test.ts`

**Interfaces:**
- Consumes: `serving.sqlite` schema from plan 1 Task 5.
- Produces:
  - Types `Customer`, `Product`, `Transaction`, `Complaint`, `TxFilter { from?; to?; merchant?; minUsd?; maxUsd?; limit? }`.
  - `ServingDb { customer(id); products(customerId); transactions(customerId, filter?); transaction(customerId, txId); complaints(customerId); demoUsers(); close() }` — every customer-scoped query takes `customerId` and filters by it.
  - `openServing(path): ServingDb` (read-only).
  - `openOps(path): Database` with tables `sessions`, `disputes`, `handoffs`, `nonces`, `audit_events`, `spans`, `spend`, `rate_events`.
  - Test fixtures: `makeServing(): string` (temp file path), `makeOps(): Database`, constants `FIXTURE` ids.

- [ ] **Step 1: Write the fixtures**

`tests/server/fixtures.ts`:
```ts
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openOps } from "../../server/db/ops";

export const FIXTURE = {
  normal: "CLI-AAAAAAAAAAAA",
  suspended: "CLI-BBBBBBBBBBBB",
  repeat: "CLI-CCCCCCCCCCCC",
  txSmall: "TRX-A1SMALL000000000001",
  txLarge: "TRX-A2LARGE000000000002",
  txFraud: "TRX-A3FRAUD000000000003",
  txPending: "TRX-A4PENDING0000000004",
  txOld: "TRX-A5OLD00000000000005",
  txOther: "TRX-C1OTHER000000000006",
} as const;

/** Builds a serving.sqlite with the plan-1 schema in a temp dir and returns its path. */
export function makeServing(): string {
  const path = join(mkdtempSync(join(tmpdir(), "aido-serving-")), "serving.sqlite");
  const db = new Database(path, { create: true });
  const f = FIXTURE;
  db.exec(`
    create table customers (customer_id text, first_name text, last_name text, country text, segment text,
      customer_status text, detected_accent text, source_file text, load_id text);
    create table products (product_id text, customer_id text, product_type text, product_number_masked text,
      currency text, current_balance real, credit_limit real, product_status text, source_file text, load_id text);
    create table transactions (transaction_id text, transaction_date text, product_id text, customer_id text,
      transaction_type text, transaction_category text, amount real, currency text, amount_usd real, channel text,
      merchant_name text, merchant_category text, transaction_country text, transaction_city text,
      transaction_status text, response_code text, fraud_score real, source_file text, load_id text);
    create table complaints (complaint_id text, customer_id text, creation_date text, category text, subcategory text,
      status text, claimed_amount real, currency text, is_repeat_complainer integer, affected_product_id text,
      source_file text, load_id text);
    create table demo_users (persona text, customer_id text);
    create table meta (key text, value text);

    insert into customers values
      ('${f.normal}', 'Ana', 'López', 'México', 'Basic', 'Active', 'mexican', 'customers.csv', 'L1'),
      ('${f.suspended}', 'Juan', 'Pérez', 'Colombia', 'Plus', 'Suspended', 'colombian', 'customers.csv', 'L1'),
      ('${f.repeat}', 'Sofía', 'Gómez', 'Argentina', 'Premium', 'Active', null, 'customers.csv', 'L1');
    insert into products values
      ('PRD-A1', '${f.normal}', 'Tarjeta Crédito', '****1111', 'USD', 1200.5, 5000, 'Active', 'products.csv', 'L1'),
      ('PRD-C1', '${f.repeat}', 'Cuenta Ahorro', '****2222', 'ARS', 800000, null, 'Active', 'products.csv', 'L1');
    insert into transactions values
      ('${f.txSmall}', '2026-06-10T12:00:00', 'PRD-A1', '${f.normal}', 'Purchase', 'Food', 45, 'USD', 45, 'POS',
        'Super Ahorro', 'Food', 'México', 'CDMX', 'Approved', '00', 4, 't.csv', 'L1'),
      ('${f.txLarge}', '2026-06-11T12:00:00', 'PRD-A1', '${f.normal}', 'Purchase', 'Other', 700, 'USD', 700, 'Web',
        'Boutique Moda', 'Other', 'México', 'CDMX', 'Approved', '00', 5, 't.csv', 'L1'),
      ('${f.txFraud}', '2026-06-12T12:00:00', 'PRD-A1', '${f.normal}', 'Purchase', 'Transport', 30, 'USD', 30, 'App',
        'Uber', 'Transport', 'USA', 'Miami', 'Approved', '00', 88, 't.csv', 'L1'),
      ('${f.txPending}', '2026-06-13T12:00:00', 'PRD-A1', '${f.normal}', 'Purchase', 'Food', 20, 'USD', 20, 'POS',
        'Super Ahorro', 'Food', 'México', 'CDMX', 'Pending', null, 3, 't.csv', 'L1'),
      ('${f.txOld}', '2026-01-05T12:00:00', 'PRD-A1', '${f.normal}', 'Purchase', 'Health', 25, 'USD', 25, 'POS',
        'Farmacia Salud', 'Health', 'México', 'CDMX', 'Approved', '00', 2, 't.csv', 'L1'),
      ('${f.txOther}', '2026-06-10T09:00:00', 'PRD-C1', '${f.repeat}', 'Purchase', 'Food', 50, 'USD', 50, 'POS',
        'Mercado Central', 'Food', 'Argentina', 'Rosario', 'Approved', '00', 1, 't.csv', 'L1');
    insert into complaints values
      ('CMP-C1', '${f.repeat}', '2026-06-01T10:00:00', 'Transactions', 'Cargo no reconocido', 'Open', 50, 'USD', 1, 'PRD-C1', 'c.csv', 'L1');
    insert into demo_users values ('normal', '${f.normal}'), ('suspended', '${f.suspended}'), ('repeat_complainer', '${f.repeat}');
    insert into meta values ('clock', '2026-06-17');
  `);
  db.close();
  return path;
}

export const makeOps = (): Database => openOps(":memory:");
```

- [ ] **Step 2: Write the failing test**

`tests/server/db.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { openServing } from "../../server/db/serving";
import { FIXTURE, makeOps, makeServing } from "./fixtures";

describe("openServing", () => {
  const serving = openServing(makeServing());

  test("scopes transaction lookups to the customer", () => {
    expect(serving.transaction(FIXTURE.normal, FIXTURE.txSmall)?.merchant_name).toBe("Super Ahorro");
    expect(serving.transaction(FIXTURE.normal, FIXTURE.txOther)).toBeNull();
  });

  test("filters transactions by merchant and amount, newest first", () => {
    const byMerchant = serving.transactions(FIXTURE.normal, { merchant: "ahorro" }).map((t) => t.transaction_id);
    expect(byMerchant).toEqual([FIXTURE.txPending, FIXTURE.txSmall]);
    const large = serving.transactions(FIXTURE.normal, { minUsd: 500 }).map((t) => t.transaction_id);
    expect(large).toEqual([FIXTURE.txLarge]);
    const june = serving.transactions(FIXTURE.normal, { from: "2026-06-11", to: "2026-06-13" });
    expect(june.map((t) => t.transaction_id)).toEqual([FIXTURE.txFraud, FIXTURE.txLarge]);
  });

  test("returns products, complaints and demo users", () => {
    expect(serving.products(FIXTURE.normal).map((p) => p.product_number_masked)).toEqual(["****1111"]);
    expect(serving.complaints(FIXTURE.repeat)[0]?.is_repeat_complainer).toBe(1);
    expect(serving.demoUsers().map((d) => d.persona).sort()).toEqual(["normal", "repeat_complainer", "suspended"]);
    expect(serving.customer(FIXTURE.suspended)?.customer_status).toBe("Suspended");
  });
});

describe("openOps", () => {
  test("creates the operational tables", () => {
    const ops = makeOps();
    const names = ops
      .query<{ name: string }, []>("select name from sqlite_master where type = 'table' order by name")
      .all()
      .map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(["audit_events", "disputes", "handoffs", "nonces", "rate_events", "sessions", "spans", "spend"]),
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/server/db.test.ts`
Expected: FAIL, cannot resolve `../../server/db/ops`.

- [ ] **Step 4: Implement**

`server/db/serving.ts`:
```ts
import { Database } from "bun:sqlite";

export interface Customer {
  customer_id: string;
  first_name: string;
  last_name: string;
  country: string;
  segment: string;
  customer_status: string;
  detected_accent: string | null;
}

export interface Product {
  product_id: string;
  customer_id: string;
  product_type: string;
  product_number_masked: string;
  currency: string;
  current_balance: number;
  credit_limit: number | null;
  product_status: string;
}

export interface Transaction {
  transaction_id: string;
  transaction_date: string;
  product_id: string;
  customer_id: string;
  transaction_type: string;
  transaction_category: string | null;
  amount: number;
  currency: string;
  amount_usd: number | null;
  channel: string;
  merchant_name: string | null;
  merchant_category: string | null;
  transaction_country: string;
  transaction_city: string | null;
  transaction_status: string;
  response_code: string | null;
  fraud_score: number | null;
}

export interface Complaint {
  complaint_id: string;
  customer_id: string;
  creation_date: string;
  category: string;
  subcategory: string | null;
  status: string;
  claimed_amount: number | null;
  currency: string | null;
  is_repeat_complainer: number;
  affected_product_id: string | null;
}

export interface TxFilter {
  /** Inclusive ISO date/time lower bound. */
  from?: string;
  /** Exclusive ISO date/time upper bound. */
  to?: string;
  merchant?: string;
  minUsd?: number;
  maxUsd?: number;
  limit?: number;
}

export interface ServingDb {
  customer(customerId: string): Customer | null;
  products(customerId: string): Product[];
  transactions(customerId: string, filter?: TxFilter): Transaction[];
  transaction(customerId: string, transactionId: string): Transaction | null;
  complaints(customerId: string): Complaint[];
  demoUsers(): { persona: string; customer_id: string }[];
  close(): void;
}

const TX_COLUMNS = `transaction_id, transaction_date, product_id, customer_id, transaction_type, transaction_category,
  amount, currency, amount_usd, channel, merchant_name, merchant_category, transaction_country, transaction_city,
  transaction_status, response_code, fraud_score`;

type Params = Record<string, string | number>;

export function openServing(path: string): ServingDb {
  const db = new Database(path, { readonly: true });
  return {
    customer: (customerId) =>
      db
        .query<Customer, [string]>(
          "select customer_id, first_name, last_name, country, segment, customer_status, detected_accent from customers where customer_id = ?",
        )
        .get(customerId),
    products: (customerId) =>
      db
        .query<Product, [string]>(
          "select product_id, customer_id, product_type, product_number_masked, currency, current_balance, credit_limit, product_status from products where customer_id = ? order by product_id",
        )
        .all(customerId),
    transactions(customerId, filter = {}) {
      const where = ["customer_id = $customer"];
      const params: Params = { $customer: customerId, $limit: filter.limit ?? 50 };
      if (filter.from) {
        where.push("transaction_date >= $from");
        params.$from = filter.from;
      }
      if (filter.to) {
        where.push("transaction_date < $to");
        params.$to = filter.to;
      }
      if (filter.merchant) {
        where.push("lower(merchant_name) like $merchant");
        params.$merchant = `%${filter.merchant.toLowerCase()}%`;
      }
      if (filter.minUsd !== undefined) {
        where.push("amount_usd >= $minUsd");
        params.$minUsd = filter.minUsd;
      }
      if (filter.maxUsd !== undefined) {
        where.push("amount_usd <= $maxUsd");
        params.$maxUsd = filter.maxUsd;
      }
      return db
        .query<Transaction, Params>(
          `select ${TX_COLUMNS} from transactions where ${where.join(" and ")} order by transaction_date desc limit $limit`,
        )
        .all(params);
    },
    transaction: (customerId, transactionId) =>
      db
        .query<Transaction, [string, string]>(
          `select ${TX_COLUMNS} from transactions where customer_id = ? and transaction_id = ?`,
        )
        .get(customerId, transactionId),
    complaints: (customerId) =>
      db
        .query<Complaint, [string]>(
          "select complaint_id, customer_id, creation_date, category, subcategory, status, claimed_amount, currency, is_repeat_complainer, affected_product_id from complaints where customer_id = ? order by creation_date desc",
        )
        .all(customerId),
    demoUsers: () => db.query<{ persona: string; customer_id: string }, []>("select persona, customer_id from demo_users").all(),
    close: () => db.close(),
  };
}
```

`server/db/ops.ts`:
```ts
import { Database } from "bun:sqlite";

const MIGRATIONS = `
  create table if not exists sessions (
    session_id text primary key, customer_id text, role text not null, language text not null,
    created_at text not null, expires_at text not null, status text not null default 'active',
    risk_score real not null default 0, turns integer not null default 0, tokens integer not null default 0);
  create table if not exists disputes (
    dispute_id text primary key, idempotency_key text not null unique, session_id text not null,
    customer_id text not null, transaction_ids text not null, reason text not null, customer_note text,
    note_untrusted integer not null default 1, amount_usd real not null, status text not null, created_at text not null);
  create table if not exists handoffs (
    handoff_id text primary key, session_id text not null, customer_id text not null, rule_ids text not null,
    card text not null, status text not null default 'queued', created_at text not null,
    taken_by text, resolved_at text);
  create table if not exists nonces (
    nonce text primary key, session_id text not null, interrupt_id text not null, payload_hash text not null,
    expires_at integer not null, used_at integer);
  create table if not exists audit_events (
    seq integer primary key autoincrement, at text not null, session_id text, kind text not null, rule_id text,
    payload text not null, prev_hash text not null, hash text not null);
  create table if not exists spans (
    span_id text primary key, trace_id text not null, session_id text not null, parent_id text, name text not null,
    started_at text not null, duration_ms real not null, attributes text not null);
  create table if not exists spend (day text primary key, usd real not null default 0);
  create table if not exists rate_events (session_id text not null, at_ms integer not null);
  create index if not exists rate_events_session on rate_events (session_id, at_ms);
`;

export function openOps(path: string): Database {
  const db = new Database(path, { create: true });
  if (path !== ":memory:") db.exec("pragma journal_mode = wal");
  db.exec(MIGRATIONS);
  return db;
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test tests/server/db.test.ts && bun run typecheck`
Expected: PASS, typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add server/db tests/server/fixtures.ts tests/server/db.test.ts
git commit -m "feat(server): add serving and ops database access"
```

---

### Task 3: Hash-chained audit log

**Files:**
- Create: `server/audit.ts`
- Test: `tests/server/audit.test.ts`

**Interfaces:**
- Consumes: `sha256Hex`, `makeOps`.
- Produces: `AuditInput { sessionId: string | null; kind: string; ruleId?: string; payload: unknown }`, `appendAudit(ops, input, now?): { seq: number; hash: string }`, `verifyAuditChain(ops): { ok: true } | { ok: false; brokenAt: number }`. First `prev_hash` is `"GENESIS"`; `hash = sha256(prev_hash|at|session_id|kind|rule_id|payload_json)`.

- [ ] **Step 1: Write the failing test**

`tests/server/audit.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { appendAudit, verifyAuditChain } from "../../server/audit";
import { makeOps } from "./fixtures";

describe("audit log", () => {
  test("chains hashes and detects tampering", () => {
    const ops = makeOps();
    const first = appendAudit(ops, { sessionId: "s1", kind: "policy", ruleId: "POL_DSP_OK", payload: { a: 1 } });
    appendAudit(ops, { sessionId: "s1", kind: "tool", ruleId: "TL_OK", payload: { b: 2 } });
    appendAudit(ops, { sessionId: null, kind: "system", payload: {} });
    expect(first.seq).toBe(1);
    expect(verifyAuditChain(ops)).toEqual({ ok: true });

    ops.query("update audit_events set payload = '{\"b\":3}' where seq = 2").run();
    expect(verifyAuditChain(ops)).toEqual({ ok: false, brokenAt: 2 });
  });

  test("links each event to the previous hash", () => {
    const ops = makeOps();
    const a = appendAudit(ops, { sessionId: "s1", kind: "k", payload: 1 });
    appendAudit(ops, { sessionId: "s1", kind: "k", payload: 2 });
    const row = ops.query<{ prev_hash: string }, []>("select prev_hash from audit_events where seq = 2").get();
    expect(row?.prev_hash).toBe(a.hash);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/audit.test.ts`
Expected: FAIL, cannot resolve `../../server/audit`.

- [ ] **Step 3: Implement**

`server/audit.ts`:
```ts
import type { Database } from "bun:sqlite";
import { sha256Hex } from "./hash";

export interface AuditInput {
  sessionId: string | null;
  kind: string;
  ruleId?: string;
  payload: unknown;
}

interface AuditRow {
  seq: number;
  at: string;
  session_id: string | null;
  kind: string;
  rule_id: string | null;
  payload: string;
  prev_hash: string;
  hash: string;
}

const link = (prev: string, at: string, sessionId: string | null, kind: string, ruleId: string | null, payload: string) =>
  sha256Hex([prev, at, sessionId ?? "", kind, ruleId ?? "", payload].join("|"));

/** Append-only, hash-chained record of gate decisions and actions. */
export function appendAudit(ops: Database, input: AuditInput, now: Date = new Date()): { seq: number; hash: string } {
  const prev = ops.query<{ hash: string }, []>("select hash from audit_events order by seq desc limit 1").get()?.hash ?? "GENESIS";
  const at = now.toISOString();
  const payload = JSON.stringify(input.payload ?? null);
  const hash = link(prev, at, input.sessionId, input.kind, input.ruleId ?? null, payload);
  const row = ops
    .query<{ seq: number }, [string, string | null, string, string | null, string, string, string]>(
      "insert into audit_events (at, session_id, kind, rule_id, payload, prev_hash, hash) values (?, ?, ?, ?, ?, ?, ?) returning seq",
    )
    .get(at, input.sessionId, input.kind, input.ruleId ?? null, payload, prev, hash);
  if (!row) throw new Error("audit insert returned no row");
  return { seq: row.seq, hash };
}

export function verifyAuditChain(ops: Database): { ok: true } | { ok: false; brokenAt: number } {
  let prev = "GENESIS";
  for (const r of ops.query<AuditRow, []>("select * from audit_events order by seq").all()) {
    if (r.prev_hash !== prev || link(prev, r.at, r.session_id, r.kind, r.rule_id, r.payload) !== r.hash) {
      return { ok: false, brokenAt: r.seq };
    }
    prev = r.hash;
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/server/audit.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/audit.ts tests/server/audit.test.ts
git commit -m "feat(server): add hash-chained audit log"
```

---

### Task 4: Authentication and sessions

**Files:**
- Create: `server/auth.ts`
- Test: `tests/server/auth.test.ts`

**Interfaces:**
- Consumes: `ServerConfig` (fields `jwtSecret`, `sessionTtlSeconds`, `demoPin`, `agentPin`), `ServingDb`, `openOps`, `Val`, `val`.
- Produces: `Role = "customer" | "agent"`, `Language = "es" | "pt"`, `Session { sessionId; role; customerId: Val<string> | null; language; expiresAt }`, `AuthError { ruleId }`, `Auth { login(persona, pin, language); agentLogin(pin); verify(token) }`, `createAuth(cfg, serving, ops, now?)`. Rule ids: `IN_AUTH_001` (bad credentials), `IN_AUTH_002` (invalid token), `IN_SESSION_EXPIRED`, `IN_SESSION_REVOKED`. Customer `customerId` is `val(id, "jwt")`.

- [ ] **Step 1: Write the failing test**

`tests/server/auth.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { AuthError, createAuth } from "../../server/auth";
import { openServing } from "../../server/db/serving";
import { FIXTURE, makeOps, makeServing } from "./fixtures";

const cfg = {
  jwtSecret: new TextEncoder().encode("s".repeat(32)),
  sessionTtlSeconds: 900,
  demoPin: "2468",
  agentPin: "1357",
};

function setup(start = Date.parse("2026-10-02T12:00:00Z")) {
  let nowMs = start;
  const ops = makeOps();
  const auth = createAuth(cfg, openServing(makeServing()), ops, () => nowMs);
  return { auth, ops, advance: (ms: number) => (nowMs += ms) };
}

async function ruleOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "no error";
  } catch (e) {
    return e instanceof AuthError ? e.ruleId : String(e);
  }
}

describe("auth", () => {
  test("customer login yields a jwt-sourced customer id", async () => {
    const { auth } = setup();
    const { token, session } = await auth.login("normal", "2468", "pt");
    expect(session.customerId).toEqual({ v: FIXTURE.normal, src: "jwt" });
    expect(session.language).toBe("pt");
    const verified = await auth.verify(token);
    expect(verified.sessionId).toBe(session.sessionId);
    expect(verified.customerId).toEqual({ v: FIXTURE.normal, src: "jwt" });
  });

  test("rejects wrong pin and unknown persona", async () => {
    const { auth } = setup();
    expect(await ruleOf(auth.login("normal", "0000", "es"))).toBe("IN_AUTH_001");
    expect(await ruleOf(auth.login("ghost", "2468", "es"))).toBe("IN_AUTH_001");
  });

  test("expired and tampered tokens are rejected", async () => {
    const { auth, advance } = setup();
    const { token } = await auth.login("normal", "2468", "es");
    expect(await ruleOf(auth.verify(`${token.slice(0, -2)}xx`))).toBe("IN_AUTH_002");
    advance(16 * 60 * 1000);
    expect(await ruleOf(auth.verify(token))).toBe("IN_SESSION_EXPIRED");
  });

  test("revoked sessions are rejected", async () => {
    const { auth, ops } = setup();
    const { token, session } = await auth.login("normal", "2468", "es");
    ops.query("update sessions set status = 'closed' where session_id = ?").run(session.sessionId);
    expect(await ruleOf(auth.verify(token))).toBe("IN_SESSION_REVOKED");
  });

  test("agent login has no customer", async () => {
    const { auth } = setup();
    expect(await ruleOf(auth.agentLogin("bad"))).toBe("IN_AUTH_001");
    const { token } = await auth.agentLogin("1357");
    const s = await auth.verify(token);
    expect(s.role).toBe("agent");
    expect(s.customerId).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/auth.test.ts`
Expected: FAIL, cannot resolve `../../server/auth`.

- [ ] **Step 3: Implement**

`server/auth.ts`:
```ts
import type { Database } from "bun:sqlite";
import { SignJWT, errors, jwtVerify } from "jose";
import type { ServerConfig } from "./config";
import type { ServingDb } from "./db/serving";
import { type Val, val } from "./provenance";

export type Role = "customer" | "agent";
export type Language = "es" | "pt";

export interface Session {
  sessionId: string;
  role: Role;
  customerId: Val<string> | null;
  language: Language;
  expiresAt: number;
}

export class AuthError extends Error {
  constructor(
    readonly ruleId: "IN_AUTH_001" | "IN_AUTH_002" | "IN_SESSION_EXPIRED" | "IN_SESSION_REVOKED",
    message: string,
  ) {
    super(`${ruleId}: ${message}`);
  }
}

export interface Auth {
  login(persona: string, pin: string, language: Language): Promise<{ token: string; session: Session }>;
  agentLogin(pin: string): Promise<{ token: string; session: Session }>;
  verify(token: string): Promise<Session>;
}

type AuthConfig = Pick<ServerConfig, "jwtSecret" | "sessionTtlSeconds" | "demoPin" | "agentPin">;

export function createAuth(cfg: AuthConfig, serving: ServingDb, ops: Database, now: () => number = Date.now): Auth {
  const issue = async (role: Role, customerId: string | null, language: Language) => {
    const sessionId = crypto.randomUUID();
    const iat = Math.floor(now() / 1000);
    const exp = iat + cfg.sessionTtlSeconds;
    ops
      .query(
        "insert into sessions (session_id, customer_id, role, language, created_at, expires_at) values (?, ?, ?, ?, ?, ?)",
      )
      .run(sessionId, customerId, role, language, new Date(iat * 1000).toISOString(), new Date(exp * 1000).toISOString());
    const token = await new SignJWT({ sid: sessionId, role, lang: language })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(customerId ?? "agent")
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(cfg.jwtSecret);
    const session: Session = {
      sessionId,
      role,
      customerId: customerId ? val(customerId, "jwt") : null,
      language,
      expiresAt: exp * 1000,
    };
    return { token, session };
  };

  return {
    async login(persona, pin, language) {
      const user = serving.demoUsers().find((d) => d.persona === persona);
      if (!user || pin !== cfg.demoPin) throw new AuthError("IN_AUTH_001", "invalid demo credentials");
      return issue("customer", user.customer_id, language);
    },
    async agentLogin(pin) {
      if (pin !== cfg.agentPin) throw new AuthError("IN_AUTH_001", "invalid agent credentials");
      return issue("agent", null, "es");
    },
    async verify(token) {
      let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
      try {
        ({ payload } = await jwtVerify(token, cfg.jwtSecret, { algorithms: ["HS256"], currentDate: new Date(now()) }));
      } catch (e) {
        if (e instanceof errors.JWTExpired) throw new AuthError("IN_SESSION_EXPIRED", "session expired");
        throw new AuthError("IN_AUTH_002", "invalid token");
      }
      const sessionId = String(payload.sid);
      const row = ops
        .query<{ status: string; language: Language; role: Role; customer_id: string | null }, [string]>(
          "select status, language, role, customer_id from sessions where session_id = ?",
        )
        .get(sessionId);
      if (!row || row.status !== "active") throw new AuthError("IN_SESSION_REVOKED", "session is not active");
      return {
        sessionId,
        role: row.role,
        customerId: row.customer_id ? val(row.customer_id, "jwt") : null,
        language: row.language,
        expiresAt: (payload.exp ?? 0) * 1000,
      };
    },
  };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/server/auth.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/auth.ts tests/server/auth.test.ts
git commit -m "feat(server): add demo login, agent login and JWT sessions"
```

---

### Task 5: Tool runtime and ownership-checked tools

**Files:**
- Create: `server/tools/runtime.ts`, `server/tools/index.ts`
- Test: `tests/server/tools.test.ts`

**Interfaces:**
- Consumes: `ServingDb`, `Transaction`, `Product`, `Complaint`, `TxFilter`, `Val`, `val`, `trusted`, `ProvenanceError`, `sha256Hex`, `makeOps`, `makeServing`, `FIXTURE`.
- Produces:
  - `ToolError { ruleId; tool; retryable }`; `RunOptions { timeoutMs; retries; backoffMs }`; `runTool<T>(tool, fn, opts?): Promise<{ value: T; attempts: number }>`. Retries timeouts and unexpected errors up to `retries` times; never retries `ProvenanceError` or non-retryable `ToolError`; exhaustion throws `ToolError("TL_FAIL")`.
  - `DisputeReason = "unrecognized" | "incorrect_amount" | "duplicate"`; `Dispute { dispute_id; customer_id; transaction_ids: string[]; reason; amount_usd; status: "received"; created_at; customer_note: string | null }`.
  - `HandoffCard { summary; verifiedFacts: { kind: string; id: string; detail: string }[]; actionsTaken: string[]; ruleIds: string[]; openQuestions: string[]; language: "es" | "pt"; sentiment?: string }`.
  - `Tools` with `getAccounts(customerId)`, `searchTransactions(customerId, filter)`, `getTransaction(customerId, txId)`, `getDisputeHistory(customerId)`, `createDispute(input)`, `getDispute(customerId, disputeId)`, `createHandoff(input)`; `createTools(serving, ops)`. Every result is a `Val` with `src: "db"`. `customerId` arguments must be `src: "jwt"`; dispute transactions must be `src: "db"` and owned by the customer. `sanitizeNote(text)`.

- [ ] **Step 1: Write the failing test**

`tests/server/tools.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { openServing } from "../../server/db/serving";
import { ProvenanceError, val } from "../../server/provenance";
import { createTools, sanitizeNote } from "../../server/tools";
import { ToolError, runTool } from "../../server/tools/runtime";
import { FIXTURE, makeOps, makeServing } from "./fixtures";

const me = val(FIXTURE.normal, "jwt");

function setup() {
  const ops = makeOps();
  return { ops, tools: createTools(openServing(makeServing()), ops) };
}

describe("runTool", () => {
  test("retries transient failures and reports attempts", async () => {
    let calls = 0;
    const r = await runTool("flaky", () => {
      calls++;
      if (calls < 3) throw new Error("busy");
      return "ok";
    }, { backoffMs: 1 });
    expect(r).toEqual({ value: "ok", attempts: 3 });
  });

  test("times out and fails with TL_FAIL after bounded retries", async () => {
    let calls = 0;
    const p = runTool("slow", () => {
      calls++;
      return new Promise<never>(() => {});
    }, { timeoutMs: 10, retries: 2, backoffMs: 1 });
    await expect(p).rejects.toMatchObject({ ruleId: "TL_FAIL", tool: "slow" });
    expect(calls).toBe(3);
  });

  test("does not retry provenance or non-retryable tool errors", async () => {
    let calls = 0;
    await expect(
      runTool("x", () => {
        calls++;
        throw new ProvenanceError("customerId", "llm");
      }),
    ).rejects.toBeInstanceOf(ProvenanceError);
    expect(calls).toBe(1);
  });
});

describe("tools", () => {
  test("reads are scoped to the session customer and tagged db", () => {
    const { tools } = setup();
    expect(tools.getTransaction(me, val(FIXTURE.txSmall, "llm"))).toMatchObject({ src: "db", v: { amount_usd: 45 } });
    expect(() => tools.getTransaction(me, val(FIXTURE.txOther, "user"))).toThrow(ToolError);
    expect(tools.searchTransactions(me, { merchant: "uber" }).v.map((t) => t.transaction_id)).toEqual([FIXTURE.txFraud]);
  });

  test("rejects identity values that did not come from the JWT", () => {
    const { tools } = setup();
    expect(() => tools.getAccounts(val(FIXTURE.normal, "llm"))).toThrow(ProvenanceError);
    expect(() => tools.searchTransactions(val(FIXTURE.repeat, "user"), {})).toThrow("PROV_001");
  });

  test("createDispute requires db-sourced transactions owned by the customer and is idempotent", () => {
    const { tools, ops } = setup();
    const tx = tools.getTransaction(me, val(FIXTURE.txSmall, "user"));
    const input = {
      sessionId: "s1",
      customerId: me,
      transactions: [tx],
      reason: "unrecognized" as const,
      customerNote: val("No reconozco <script>alert(1)</script> este cargo\u0007", "user" as const),
      idempotencyKey: "s1:int-1",
    };
    const first = tools.createDispute(input);
    const second = tools.createDispute(input);
    expect(first.v.dispute_id).toMatch(/^D-[0-9A-F]{8}$/);
    expect(second.v.dispute_id).toBe(first.v.dispute_id);
    expect(first.v).toMatchObject({ amount_usd: 45, status: "received", transaction_ids: [FIXTURE.txSmall] });
    expect(first.v.customer_note).toBe("No reconozco scriptalert(1)/script este cargo");
    expect(ops.query<{ n: number }, []>("select count(*) as n from disputes").get()?.n).toBe(1);
    expect(ops.query<{ u: number }, []>("select note_untrusted as u from disputes").get()?.u).toBe(1);

    const forged = { ...input, idempotencyKey: "s1:int-2", transactions: [val(tx.v, "llm" as const)] };
    expect(() => tools.createDispute(forged)).toThrow("PROV_001");
  });

  test("createDispute refuses transactions of another customer even if db-sourced", () => {
    const { tools } = setup();
    const other = createTools(openServing(makeServing()), makeOps()).getTransaction(
      val(FIXTURE.repeat, "jwt"),
      val(FIXTURE.txOther, "user"),
    );
    expect(() =>
      tools.createDispute({
        sessionId: "s1",
        customerId: me,
        transactions: [other],
        reason: "unrecognized",
        customerNote: null,
        idempotencyKey: "k",
      }),
    ).toThrow("TL_OWNER");
  });

  test("getDispute is scoped and history includes created disputes", () => {
    const { tools } = setup();
    const tx = tools.getTransaction(me, val(FIXTURE.txSmall, "user"));
    const d = tools.createDispute({
      sessionId: "s1",
      customerId: me,
      transactions: [tx],
      reason: "duplicate",
      customerNote: null,
      idempotencyKey: "k1",
    });
    expect(tools.getDispute(me, d.v.dispute_id)?.v.dispute_id).toBe(d.v.dispute_id);
    expect(tools.getDispute(val(FIXTURE.repeat, "jwt"), d.v.dispute_id)).toBeNull();
    expect(tools.getDisputeHistory(me).v.disputedTransactionIds).toEqual([FIXTURE.txSmall]);
    expect(tools.getDisputeHistory(val(FIXTURE.repeat, "jwt")).v.repeatComplainer).toBe(true);
  });

  test("createHandoff stores a structured card", () => {
    const { tools, ops } = setup();
    const h = tools.createHandoff({
      sessionId: "s1",
      customerId: me,
      ruleIds: ["POL_DSP_AMOUNT"],
      card: {
        summary: "Disputa de cargo alto",
        verifiedFacts: [{ kind: "transaction", id: FIXTURE.txLarge, detail: "USD 700 Boutique Moda" }],
        actionsTaken: [],
        ruleIds: ["POL_DSP_AMOUNT"],
        openQuestions: ["¿Reconoce el comercio?"],
        language: "es",
      },
    });
    expect(h.v.handoffId).toMatch(/^H-/);
    expect(ops.query<{ status: string }, []>("select status from handoffs").get()?.status).toBe("queued");
  });

  test("sanitizeNote strips control characters and markup, caps length", () => {
    expect(sanitizeNote(" a\u0000b <b>c</b> `d` ")).toBe("a b bc/b d");
    expect(sanitizeNote("x".repeat(900)).length).toBe(500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/tools.test.ts`
Expected: FAIL, cannot resolve `../../server/tools`.

- [ ] **Step 3: Implement the runtime**

`server/tools/runtime.ts`:
```ts
import { ProvenanceError } from "../provenance";

export class ToolError extends Error {
  constructor(
    readonly ruleId: string,
    readonly tool: string,
    message: string,
    readonly retryable = false,
  ) {
    super(`${ruleId} (${tool}): ${message}`);
  }
}

export interface RunOptions {
  timeoutMs: number;
  retries: number;
  backoffMs: number;
}

const DEFAULTS: RunOptions = { timeoutMs: 3000, retries: 2, backoffMs: 100 };

class Timeout extends Error {}

const isRetryable = (e: unknown) =>
  !(e instanceof ProvenanceError) && !(e instanceof ToolError && !e.retryable);

/** Runs a tool with a timeout and bounded exponential-backoff retries. */
export async function runTool<T>(
  tool: string,
  fn: () => Promise<T> | T,
  options: Partial<RunOptions> = {},
): Promise<{ value: T; attempts: number }> {
  const o = { ...DEFAULTS, ...options };
  let last: unknown;
  for (let attempt = 1; attempt <= o.retries + 1; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Timeout(`timed out after ${o.timeoutMs} ms`)), o.timeoutMs);
      });
      const value = await Promise.race([Promise.resolve().then(fn), timeout]);
      return { value, attempts: attempt };
    } catch (e) {
      last = e;
      if (!isRetryable(e)) throw e;
      if (attempt <= o.retries) await Bun.sleep(o.backoffMs * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new ToolError("TL_FAIL", tool, last instanceof Error ? last.message : String(last));
}
```

- [ ] **Step 4: Implement the tools**

`server/tools/index.ts`:
```ts
import type { Database } from "bun:sqlite";
import type { Complaint, Product, ServingDb, Transaction, TxFilter } from "../db/serving";
import { sha256Hex } from "../hash";
import { type Val, trusted, val } from "../provenance";
import { ToolError } from "./runtime";

export type DisputeReason = "unrecognized" | "incorrect_amount" | "duplicate";

export interface Dispute {
  dispute_id: string;
  customer_id: string;
  transaction_ids: string[];
  reason: DisputeReason;
  amount_usd: number;
  status: "received";
  created_at: string;
  customer_note: string | null;
}

export interface HandoffCard {
  summary: string;
  verifiedFacts: { kind: string; id: string; detail: string }[];
  actionsTaken: string[];
  ruleIds: string[];
  openQuestions: string[];
  language: "es" | "pt";
  sentiment?: string;
}

export interface DisputeHistory {
  complaints: Complaint[];
  disputedTransactionIds: string[];
  repeatComplainer: boolean;
}

export interface CreateDisputeInput {
  sessionId: string;
  customerId: Val<string>;
  transactions: Val<Transaction>[];
  reason: DisputeReason;
  customerNote: Val<string> | null;
  idempotencyKey: string;
}

export interface Tools {
  getAccounts(customerId: Val<string>): Val<Product[]>;
  searchTransactions(customerId: Val<string>, filter: TxFilter): Val<Transaction[]>;
  /** The transaction id may come from any source: the lookup is scoped to the session customer. */
  getTransaction(customerId: Val<string>, transactionId: Val<string>): Val<Transaction>;
  getDisputeHistory(customerId: Val<string>): Val<DisputeHistory>;
  createDispute(input: CreateDisputeInput): Val<Dispute>;
  getDispute(customerId: Val<string>, disputeId: string): Val<Dispute> | null;
  createHandoff(input: { sessionId: string; customerId: Val<string>; ruleIds: string[]; card: HandoffCard }): Val<{
    handoffId: string;
  }>;
}

/** Untrusted customer text stored for humans: no control chars, no markup characters, bounded length. */
export function sanitizeNote(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[<>`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

interface DisputeRow {
  dispute_id: string;
  customer_id: string;
  transaction_ids: string;
  reason: DisputeReason;
  amount_usd: number;
  status: "received";
  created_at: string;
  customer_note: string | null;
}

const toDispute = (r: DisputeRow): Dispute => ({ ...r, transaction_ids: JSON.parse(r.transaction_ids) as string[] });

export function createTools(serving: ServingDb, ops: Database, now: () => Date = () => new Date()): Tools {
  const customer = (v: Val<string>) => trusted("customerId", v, ["jwt"]);
  const disputeById = (customerId: string, disputeId: string) =>
    ops
      .query<DisputeRow, [string, string]>("select * from disputes where customer_id = ? and dispute_id = ?")
      .get(customerId, disputeId);

  return {
    getAccounts: (customerId) => val(serving.products(customer(customerId)), "db"),
    searchTransactions: (customerId, filter) => val(serving.transactions(customer(customerId), filter), "db"),
    getTransaction(customerId, transactionId) {
      const tx = serving.transaction(customer(customerId), transactionId.v);
      if (!tx) throw new ToolError("TL_NOT_FOUND", "getTransaction", "no such transaction for this customer");
      return val(tx, "db");
    },
    getDisputeHistory(customerId) {
      const id = customer(customerId);
      const complaints = serving.complaints(id);
      const disputed = ops
        .query<{ transaction_ids: string }, [string]>("select transaction_ids from disputes where customer_id = ?")
        .all(id)
        .flatMap((r) => JSON.parse(r.transaction_ids) as string[]);
      return val(
        {
          complaints,
          disputedTransactionIds: [...new Set(disputed)].sort(),
          repeatComplainer: complaints.some((c) => c.is_repeat_complainer === 1),
        },
        "db",
      );
    },
    createDispute(input) {
      const customerId = customer(input.customerId);
      const txs = input.transactions.map((t) => trusted("transaction", t, ["db"]));
      for (const t of txs) {
        if (t.customer_id !== customerId) {
          throw new ToolError("TL_OWNER", "createDispute", "transaction does not belong to the session customer");
        }
      }
      const disputeId = `D-${sha256Hex(input.idempotencyKey).slice(0, 8).toUpperCase()}`;
      const note = input.customerNote ? sanitizeNote(input.customerNote.v) : null;
      ops
        .query(
          `insert into disputes (dispute_id, idempotency_key, session_id, customer_id, transaction_ids, reason,
             customer_note, note_untrusted, amount_usd, status, created_at)
           values (?, ?, ?, ?, ?, ?, ?, 1, ?, 'received', ?)
           on conflict (idempotency_key) do nothing`,
        )
        .run(
          disputeId,
          input.idempotencyKey,
          input.sessionId,
          customerId,
          JSON.stringify(txs.map((t) => t.transaction_id)),
          input.reason,
          note,
          txs.reduce((sum, t) => sum + (t.amount_usd ?? 0), 0),
          now().toISOString(),
        );
      const row = ops
        .query<DisputeRow, [string]>("select * from disputes where idempotency_key = ?")
        .get(input.idempotencyKey);
      if (!row) throw new ToolError("TL_FAIL", "createDispute", "dispute not persisted", true);
      return val(toDispute(row), "db");
    },
    getDispute(customerId, disputeId) {
      const row = disputeById(customer(customerId), disputeId);
      return row ? val(toDispute(row), "db") : null;
    },
    createHandoff(input) {
      const customerId = customer(input.customerId);
      const handoffId = `H-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      ops
        .query(
          "insert into handoffs (handoff_id, session_id, customer_id, rule_ids, card, created_at) values (?, ?, ?, ?, ?, ?)",
        )
        .run(
          handoffId,
          input.sessionId,
          customerId,
          JSON.stringify(input.ruleIds),
          JSON.stringify(input.card),
          now().toISOString(),
        );
      return val({ handoffId }, "db");
    },
  };
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test tests/server/tools.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/tools tests/server/tools.test.ts
git commit -m "feat(server): add tool runtime and ownership-checked tools"
```

---

### Task 6: Policy engine

**Files:**
- Create: `server/policy/rules.ts`
- Test: `tests/server/policy.test.ts`

**Interfaces:**
- Consumes: `Policy`, `POLICY`, `Customer`, `Transaction`.
- Produces: `Intent = "check_balance" | "list_transactions" | "explain_charge" | "dispute_charge" | "request_human" | "out_of_scope"`, `Action = "allow" | "confirm" | "clarify" | "escalate" | "deny"`, `PolicyInput { intent; customer: Customer; targets: Transaction[]; disputedTransactionIds: string[]; repeatComplainer: boolean; riskScore: number }`, `Decision { action; ruleIds: string[]; policyVersion: string }`, `decide(input, policy?)`. Escalation rules accumulate (all matching rule ids, sorted).

Rule table:

| Condition | Action | Rule id |
|---|---|---|
| customer status Suspended or Closed | escalate | `POL_STATUS` |
| intent `request_human` | escalate | `POL_HUMAN` |
| risk score ≥ `riskEscalate` | escalate | `POL_RISK` |
| intent `out_of_scope` | deny | `POL_SCOPE` |
| intent `check_balance`, `list_transactions`, `explain_charge` | allow | `POL_READ` |
| dispute with no targets | clarify | `POL_DSP_NO_TARGET` |
| dispute targets > `maxTxPerDispute` | escalate | `POL_DSP_MANY` |
| any target `amount_usd` null or > `maxAutoUsd` | escalate | `POL_DSP_AMOUNT` |
| any target `fraud_score` ≥ `fraudScore` | escalate | `POL_DSP_FRAUD` |
| any target status ≠ Approved | escalate | `POL_DSP_STATUS` |
| any target older than `maxDisputeAgeDays` vs clock | escalate | `POL_DSP_AGE` |
| any target already disputed | escalate | `POL_DSP_DUP` |
| repeat complainer | escalate | `POL_REPEAT` |
| otherwise | confirm | `POL_DSP_OK` |

- [ ] **Step 1: Write the failing test**

`tests/server/policy.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { openServing } from "../../server/db/serving";
import { type PolicyInput, decide } from "../../server/policy/rules";
import { FIXTURE, makeServing } from "./fixtures";

const serving = openServing(makeServing());
const customer = serving.customer(FIXTURE.normal)!;
const tx = (id: string) => serving.transaction(FIXTURE.normal, id)!;

const base = (over: Partial<PolicyInput>): PolicyInput => ({
  intent: "dispute_charge",
  customer,
  targets: [],
  disputedTransactionIds: [],
  repeatComplainer: false,
  riskScore: 0,
  ...over,
});

describe("decide", () => {
  test.each([
    ["read intent is allowed", base({ intent: "list_transactions" }), "allow", ["POL_READ"]],
    ["out of scope is denied", base({ intent: "out_of_scope" }), "deny", ["POL_SCOPE"]],
    ["explicit human request escalates", base({ intent: "request_human" }), "escalate", ["POL_HUMAN"]],
    ["dispute without target asks to clarify", base({}), "clarify", ["POL_DSP_NO_TARGET"]],
    ["small approved recent dispute needs confirmation", base({ targets: [tx(FIXTURE.txSmall)] }), "confirm", ["POL_DSP_OK"]],
    ["large amount escalates", base({ targets: [tx(FIXTURE.txLarge)] }), "escalate", ["POL_DSP_AMOUNT"]],
    ["fraud score escalates", base({ targets: [tx(FIXTURE.txFraud)] }), "escalate", ["POL_DSP_FRAUD"]],
    ["pending transaction escalates", base({ targets: [tx(FIXTURE.txPending)] }), "escalate", ["POL_DSP_STATUS"]],
    ["old transaction escalates", base({ targets: [tx(FIXTURE.txOld)] }), "escalate", ["POL_DSP_AGE"]],
    [
      "already disputed escalates",
      base({ targets: [tx(FIXTURE.txSmall)], disputedTransactionIds: [FIXTURE.txSmall] }),
      "escalate",
      ["POL_DSP_DUP"],
    ],
    ["repeat complainer escalates", base({ targets: [tx(FIXTURE.txSmall)], repeatComplainer: true }), "escalate", ["POL_REPEAT"]],
    ["high risk escalates", base({ intent: "check_balance", riskScore: 3 }), "escalate", ["POL_RISK"]],
  ] as const)("%s", (_, input, action, ruleIds) => {
    expect(decide(input)).toEqual({ action, ruleIds: [...ruleIds], policyVersion: "2026-10-02.1" });
  });

  test("accumulates every escalation reason", () => {
    const d = decide(base({ targets: [tx(FIXTURE.txLarge), tx(FIXTURE.txFraud), tx(FIXTURE.txSmall)] }));
    expect(d.action).toBe("escalate");
    expect(d.ruleIds).toEqual(["POL_DSP_AMOUNT", "POL_DSP_FRAUD", "POL_DSP_MANY"]);
  });

  test("suspended customers escalate even for reads", () => {
    const suspended = serving.customer(FIXTURE.suspended)!;
    expect(decide(base({ intent: "check_balance", customer: suspended }))).toMatchObject({
      action: "escalate",
      ruleIds: ["POL_STATUS"],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/policy.test.ts`
Expected: FAIL, cannot resolve `../../server/policy/rules`.

- [ ] **Step 3: Implement**

`server/policy/rules.ts`:
```ts
import type { Customer, Transaction } from "../db/serving";
import { POLICY, type Policy } from "./config";

export type Intent =
  | "check_balance"
  | "list_transactions"
  | "explain_charge"
  | "dispute_charge"
  | "request_human"
  | "out_of_scope";

export type Action = "allow" | "confirm" | "clarify" | "escalate" | "deny";

export interface PolicyInput {
  intent: Intent;
  customer: Customer;
  /** Database-resolved transactions the request is about (dispute or explanation targets). */
  targets: Transaction[];
  disputedTransactionIds: string[];
  repeatComplainer: boolean;
  riskScore: number;
}

export interface Decision {
  action: Action;
  ruleIds: string[];
  policyVersion: string;
}

const READ_INTENTS: readonly Intent[] = ["check_balance", "list_transactions", "explain_charge"];
const DAY_MS = 86_400_000;

const ageDays = (tx: Transaction, clock: string) =>
  (Date.parse(`${clock}T23:59:59Z`) - Date.parse(`${tx.transaction_date}Z`)) / DAY_MS;

/** Pure policy engine: the only place that decides between acting, confirming and escalating. */
export function decide(input: PolicyInput, p: Policy = POLICY): Decision {
  const result = (action: Action, ruleIds: string[]): Decision => ({
    action,
    ruleIds: [...ruleIds].sort(),
    policyVersion: p.version,
  });

  const gate: string[] = [];
  if (input.customer.customer_status === "Suspended" || input.customer.customer_status === "Closed") gate.push("POL_STATUS");
  if (input.intent === "request_human") gate.push("POL_HUMAN");
  if (input.riskScore >= p.riskEscalate) gate.push("POL_RISK");
  if (gate.length > 0) return result("escalate", gate);

  if (input.intent === "out_of_scope") return result("deny", ["POL_SCOPE"]);
  if (READ_INTENTS.includes(input.intent)) return result("allow", ["POL_READ"]);

  if (input.targets.length === 0) return result("clarify", ["POL_DSP_NO_TARGET"]);
  const reasons = new Set<string>();
  if (input.targets.length > p.maxTxPerDispute) reasons.add("POL_DSP_MANY");
  for (const t of input.targets) {
    if (t.amount_usd === null || t.amount_usd > p.maxAutoUsd) reasons.add("POL_DSP_AMOUNT");
    if (t.fraud_score !== null && t.fraud_score >= p.fraudScore) reasons.add("POL_DSP_FRAUD");
    if (t.transaction_status !== "Approved") reasons.add("POL_DSP_STATUS");
    if (ageDays(t, p.clock) > p.maxDisputeAgeDays) reasons.add("POL_DSP_AGE");
    if (input.disputedTransactionIds.includes(t.transaction_id)) reasons.add("POL_DSP_DUP");
  }
  if (input.repeatComplainer) reasons.add("POL_REPEAT");
  return reasons.size > 0 ? result("escalate", [...reasons]) : result("confirm", ["POL_DSP_OK"]);
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/server/policy.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/policy/rules.ts tests/server/policy.test.ts
git commit -m "feat(server): add pure policy engine with rule ids"
```

---

### Task 7: PII masking and the input gate

**Files:**
- Create: `server/gates/pii.ts`, `server/gates/input.ts`
- Test: `tests/server/input.test.ts`

**Interfaces:**
- Consumes: `makeOps`.
- Produces: `PiiKind = "email" | "cpf" | "curp" | "card" | "id_doc" | "phone"`, `maskPii(text): { text: string; found: PiiKind[] }`, `luhnValid(digits)`, `cpfValid(digits)`; `InputLimits { maxChars; perMinute }`, `InputGateResult = { ok: true; text: string; piiFound: PiiKind[] } | { ok: false; ruleId: "IN_EMPTY" | "IN_SIZE" | "IN_RATE" }`, `inputGate(ops, sessionId, raw, nowMs, limits?)`.

Masking tokens: `[EMAIL]`, `[CPF]`, `[CURP]`, `[CARD]`, `[ID_DOC]`, `[PHONE]`. Cards must pass Luhn and have 13–19 digits; CPFs must pass check digits; ID documents need a keyword (`DNI`, `CC`, `cédula`, `CE`, `RG`).

- [ ] **Step 1: Write the failing test**

`tests/server/input.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { inputGate } from "../../server/gates/input";
import { cpfValid, luhnValid, maskPii } from "../../server/gates/pii";
import { makeOps } from "./fixtures";

describe("maskPii", () => {
  test("masks valid card numbers only", () => {
    expect(maskPii("mi tarjeta 4111 1111 1111 1111").text).toBe("mi tarjeta [CARD]");
    expect(maskPii("número 4111 1111 1111 1112").found).toEqual([]);
  });
  test("masks CPF, CURP, ID documents, email and phone", () => {
    const r = maskPii(
      "CPF 529.982.247-25, CURP GODE561231HDFRRN09, DNI 30123456, ana@mail.com, +52 55 1234 5678",
    );
    expect(r.text).toBe("CPF [CPF], CURP [CURP], [ID_DOC], [EMAIL], [PHONE]");
    expect(r.found).toEqual(["email", "cpf", "curp", "id_doc", "phone"]);
  });
  test("leaves amounts and dates alone", () => {
    const text = "me cobraron $1.234,56 el 10/06/2026 y otro de 45.00 USD";
    expect(maskPii(text)).toEqual({ text, found: [] });
  });
  test("checksums", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(cpfValid("52998224725")).toBe(true);
    expect(cpfValid("11111111111")).toBe(false);
  });
});

describe("inputGate", () => {
  const t0 = 1_000_000;
  test("rejects empty and oversized input", () => {
    const ops = makeOps();
    expect(inputGate(ops, "s1", "   ", t0)).toEqual({ ok: false, ruleId: "IN_EMPTY" });
    expect(inputGate(ops, "s1", "a".repeat(1001), t0)).toEqual({ ok: false, ruleId: "IN_SIZE" });
  });
  test("rate limits per session within a sliding minute", () => {
    const ops = makeOps();
    for (let i = 0; i < 12; i++) expect(inputGate(ops, "s1", "hola", t0 + i).ok).toBe(true);
    expect(inputGate(ops, "s1", "hola", t0 + 20)).toEqual({ ok: false, ruleId: "IN_RATE" });
    expect(inputGate(ops, "s2", "hola", t0 + 20).ok).toBe(true);
    expect(inputGate(ops, "s1", "hola", t0 + 61_000).ok).toBe(true);
  });
  test("returns masked text and the kinds found", () => {
    const r = inputGate(makeOps(), "s1", "mi correo es ana@mail.com", t0);
    expect(r).toEqual({ ok: true, text: "mi correo es [EMAIL]", piiFound: ["email"] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/input.test.ts`
Expected: FAIL, cannot resolve `../../server/gates/input`.

- [ ] **Step 3: Implement PII masking**

`server/gates/pii.ts`:
```ts
export type PiiKind = "email" | "cpf" | "curp" | "card" | "id_doc" | "phone";

export function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

export function cpfValid(digits: string): boolean {
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  const check = (n: number) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Number(digits[i]) * (n + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return check(9) === Number(digits[9]) && check(10) === Number(digits[10]);
}

const onlyDigits = (s: string) => s.replace(/\D/g, "");

interface Detector {
  kind: PiiKind;
  pattern: RegExp;
  token: string;
  valid?: (match: string) => boolean;
}

/** Order matters: more specific patterns run first so later ones do not split them. */
const DETECTORS: Detector[] = [
  { kind: "email", pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/g, token: "[EMAIL]" },
  { kind: "cpf", pattern: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, token: "[CPF]", valid: (m) => cpfValid(onlyDigits(m)) },
  { kind: "curp", pattern: /\b[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d\b/gi, token: "[CURP]" },
  {
    kind: "card",
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    token: "[CARD]",
    valid: (m) => {
      const d = onlyDigits(m);
      return d.length >= 13 && d.length <= 19 && luhnValid(d);
    },
  },
  { kind: "id_doc", pattern: /\b(?:DNI|CC|CE|RG|c[eé]dula)[:\s#nº°.]*\d[\d.]{5,11}\b/gi, token: "[ID_DOC]" },
  { kind: "phone", pattern: /\+\d{1,3}[\s-]?\d(?:[\s-]?\d){7,12}\b/g, token: "[PHONE]" },
];

export function maskPii(text: string): { text: string; found: PiiKind[] } {
  const found: PiiKind[] = [];
  let out = text;
  for (const d of DETECTORS) {
    out = out.replace(d.pattern, (match) => {
      if (d.valid && !d.valid(match)) return match;
      if (!found.includes(d.kind)) found.push(d.kind);
      return d.token;
    });
  }
  return { text: out, found };
}
```

- [ ] **Step 4: Implement the input gate**

`server/gates/input.ts`:
```ts
import type { Database } from "bun:sqlite";
import { type PiiKind, maskPii } from "./pii";

export interface InputLimits {
  maxChars: number;
  perMinute: number;
}

export type InputGateResult =
  | { ok: true; text: string; piiFound: PiiKind[] }
  | { ok: false; ruleId: "IN_EMPTY" | "IN_SIZE" | "IN_RATE" };

const DEFAULT_LIMITS: InputLimits = { maxChars: 1000, perMinute: 12 };

/** Gate 1: rejects empty, oversized and rate-limited messages; masks PII before anything else sees the text. */
export function inputGate(
  ops: Database,
  sessionId: string,
  raw: string,
  nowMs: number,
  limits: InputLimits = DEFAULT_LIMITS,
): InputGateResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, ruleId: "IN_EMPTY" };
  if (trimmed.length > limits.maxChars) return { ok: false, ruleId: "IN_SIZE" };

  ops.query("delete from rate_events where at_ms < ?").run(nowMs - 60_000);
  const recent =
    ops
      .query<{ n: number }, [string, number]>("select count(*) as n from rate_events where session_id = ? and at_ms > ?")
      .get(sessionId, nowMs - 60_000)?.n ?? 0;
  if (recent >= limits.perMinute) return { ok: false, ruleId: "IN_RATE" };
  ops.query("insert into rate_events (session_id, at_ms) values (?, ?)").run(sessionId, nowMs);

  const masked = maskPii(trimmed);
  return { ok: true, text: masked.text, piiFound: masked.found };
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test tests/server/input.test.ts && bun run typecheck`
Expected: PASS. If the "leaves amounts and dates alone" case fails, adjust only the offending regex boundary, never the test.

- [ ] **Step 6: Commit**

```bash
git add server/gates/pii.ts server/gates/input.ts tests/server/input.test.ts
git commit -m "feat(server): add PII masking and input gate"
```

---

### Task 8: Budgets, circuit breaker, risk score, confirmation nonces

**Files:**
- Create: `server/gates/budget.ts`, `server/gates/risk.ts`, `server/gates/nonce.ts`
- Test: `tests/server/budget.test.ts`

**Interfaces:**
- Consumes: `Budgets`, `BUDGETS`, `sha256Hex`, `makeOps`.
- Produces:
  - `checkBudget(ops, sessionId, day, budgets?): { ok: true } | { ok: false; ruleId: "BUD_TURNS" | "BUD_TOKENS" | "BUD_SPEND" }`; `recordTurn(ops, sessionId)`; `recordUsage(ops, sessionId, day, tokens, usd)`.
  - `BudgetError { ruleId: "BUD_CALLS" }`; `CallCounter(max)` with `take()` (throws on the call past `max`).
  - `CircuitBreaker({ failureThreshold, cooldownMs, now })` with `canCall()`, `success()`, `failure()`, `state: "closed" | "open" | "half_open"`.
  - `RISK_WEIGHTS { injectionSignal: 1.5, abstain: 0.5, policyDeny: 1, provenanceViolation: 3 }`; `addRisk(ops, sessionId, reason): number`; `getRisk(ops, sessionId): number`.
  - `issueNonce(ops, { sessionId, interruptId, payload }, nowMs, ttlMs?): string`; `consumeNonce(ops, { sessionId, interruptId, nonce, payload }, nowMs): { ok: true } | { ok: false; ruleId: "TL_NONCE_UNKNOWN" | "TL_NONCE_USED" | "TL_NONCE_EXPIRED" | "TL_NONCE_MISMATCH" }`.

- [ ] **Step 1: Write the failing test**

`tests/server/budget.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { BudgetError, CallCounter, CircuitBreaker, checkBudget, recordTurn, recordUsage } from "../../server/gates/budget";
import { consumeNonce, issueNonce } from "../../server/gates/nonce";
import { addRisk, getRisk } from "../../server/gates/risk";
import { makeOps } from "./fixtures";

function opsWithSession(id = "s1") {
  const ops = makeOps();
  ops
    .query("insert into sessions (session_id, customer_id, role, language, created_at, expires_at) values (?, 'CLI-X', 'customer', 'es', '', '')")
    .run(id);
  return ops;
}

const small = { maxTurns: 2, maxLlmCallsPerTurn: 3, maxTokensPerSession: 100, dailySpendUsd: 1 };

describe("budgets", () => {
  test("turn, token and daily spend limits", () => {
    const ops = opsWithSession();
    expect(checkBudget(ops, "s1", "2026-10-02", small)).toEqual({ ok: true });
    recordTurn(ops, "s1");
    recordTurn(ops, "s1");
    expect(checkBudget(ops, "s1", "2026-10-02", small)).toEqual({ ok: false, ruleId: "BUD_TURNS" });

    const ops2 = opsWithSession();
    recordUsage(ops2, "s1", "2026-10-02", 150, 0.1);
    expect(checkBudget(ops2, "s1", "2026-10-02", small)).toEqual({ ok: false, ruleId: "BUD_TOKENS" });

    const ops3 = opsWithSession();
    recordUsage(ops3, "s1", "2026-10-02", 1, 1.2);
    expect(checkBudget(ops3, "s1", "2026-10-02", small)).toEqual({ ok: false, ruleId: "BUD_SPEND" });
    expect(checkBudget(ops3, "s1", "2026-10-03", small)).toEqual({ ok: true });
  });

  test("call counter enforces the per-turn limit", () => {
    const c = new CallCounter(2);
    c.take();
    c.take();
    expect(() => c.take()).toThrow(BudgetError);
  });

  test("circuit breaker opens after repeated failures and half-opens after cooldown", () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: () => now });
    b.failure();
    expect(b.canCall()).toBe(true);
    b.failure();
    expect(b.state).toBe("open");
    expect(b.canCall()).toBe(false);
    now = 1001;
    expect(b.canCall()).toBe(true);
    expect(b.state).toBe("half_open");
    b.success();
    expect(b.state).toBe("closed");
  });
});

describe("risk score", () => {
  test("accumulates weighted signals per session", () => {
    const ops = opsWithSession();
    expect(addRisk(ops, "s1", "abstain")).toBe(0.5);
    expect(addRisk(ops, "s1", "injectionSignal")).toBe(2);
    expect(addRisk(ops, "s1", "policyDeny")).toBe(3);
    expect(getRisk(ops, "s1")).toBe(3);
  });
});

describe("nonces", () => {
  const ctx = { sessionId: "s1", interruptId: "int-1", payload: { tx: ["TRX-1"], reason: "unrecognized" } };

  test("single use, bound to session, interrupt and payload", () => {
    const ops = makeOps();
    const nonce = issueNonce(ops, ctx, 0);
    expect(consumeNonce(ops, { ...ctx, nonce, payload: { tx: ["TRX-2"], reason: "unrecognized" } }, 1)).toEqual({
      ok: false,
      ruleId: "TL_NONCE_MISMATCH",
    });
    expect(consumeNonce(ops, { ...ctx, sessionId: "s2", nonce }, 1)).toEqual({ ok: false, ruleId: "TL_NONCE_MISMATCH" });
    expect(consumeNonce(ops, { ...ctx, nonce }, 1)).toEqual({ ok: true });
    expect(consumeNonce(ops, { ...ctx, nonce }, 2)).toEqual({ ok: false, ruleId: "TL_NONCE_USED" });
  });

  test("unknown and expired nonces are rejected", () => {
    const ops = makeOps();
    expect(consumeNonce(ops, { ...ctx, nonce: "nope" }, 0)).toEqual({ ok: false, ruleId: "TL_NONCE_UNKNOWN" });
    const nonce = issueNonce(ops, ctx, 0, 1000);
    expect(consumeNonce(ops, { ...ctx, nonce }, 1001)).toEqual({ ok: false, ruleId: "TL_NONCE_EXPIRED" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/budget.test.ts`
Expected: FAIL, cannot resolve `../../server/gates/budget`.

- [ ] **Step 3: Implement budgets and breaker**

`server/gates/budget.ts`:
```ts
import type { Database } from "bun:sqlite";
import { BUDGETS, type Budgets } from "../policy/config";

export type BudgetRule = "BUD_TURNS" | "BUD_TOKENS" | "BUD_SPEND";

export function checkBudget(
  ops: Database,
  sessionId: string,
  day: string,
  budgets: Budgets = BUDGETS,
): { ok: true } | { ok: false; ruleId: BudgetRule } {
  const s = ops
    .query<{ turns: number; tokens: number }, [string]>("select turns, tokens from sessions where session_id = ?")
    .get(sessionId);
  if (s && s.turns >= budgets.maxTurns) return { ok: false, ruleId: "BUD_TURNS" };
  if (s && s.tokens >= budgets.maxTokensPerSession) return { ok: false, ruleId: "BUD_TOKENS" };
  const spent = ops.query<{ usd: number }, [string]>("select usd from spend where day = ?").get(day)?.usd ?? 0;
  if (spent >= budgets.dailySpendUsd) return { ok: false, ruleId: "BUD_SPEND" };
  return { ok: true };
}

export function recordTurn(ops: Database, sessionId: string): void {
  ops.query("update sessions set turns = turns + 1 where session_id = ?").run(sessionId);
}

export function recordUsage(ops: Database, sessionId: string, day: string, tokens: number, usd: number): void {
  ops.query("update sessions set tokens = tokens + ? where session_id = ?").run(tokens, sessionId);
  ops
    .query("insert into spend (day, usd) values (?, ?) on conflict (day) do update set usd = usd + excluded.usd")
    .run(day, usd);
}

export class BudgetError extends Error {
  readonly ruleId = "BUD_CALLS";
  constructor(max: number) {
    super(`BUD_CALLS: more than ${max} model calls in one turn`);
  }
}

/** Per-turn model call limit. Create one per turn. */
export class CallCounter {
  private used = 0;
  constructor(private readonly max: number) {}
  take(): void {
    if (this.used >= this.max) throw new BudgetError(this.max);
    this.used++;
  }
}

export interface BreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  now?: () => number;
}

/** Stops calling a failing provider; lets one trial call through after the cooldown. */
export class CircuitBreaker {
  state: "closed" | "open" | "half_open" = "closed";
  private failures = 0;
  private openedAt = 0;
  private readonly now: () => number;

  constructor(private readonly o: BreakerOptions) {
    this.now = o.now ?? Date.now;
  }

  canCall(): boolean {
    if (this.state === "open" && this.now() - this.openedAt > this.o.cooldownMs) this.state = "half_open";
    return this.state !== "open";
  }

  success(): void {
    this.failures = 0;
    this.state = "closed";
  }

  failure(): void {
    this.failures++;
    if (this.state === "half_open" || this.failures >= this.o.failureThreshold) {
      this.state = "open";
      this.openedAt = this.now();
    }
  }
}
```

- [ ] **Step 4: Implement risk and nonces**

`server/gates/risk.ts`:
```ts
import type { Database } from "bun:sqlite";

export const RISK_WEIGHTS = {
  injectionSignal: 1.5,
  abstain: 0.5,
  policyDeny: 1,
  provenanceViolation: 3,
} as const;

export type RiskReason = keyof typeof RISK_WEIGHTS;

export function getRisk(ops: Database, sessionId: string): number {
  return (
    ops.query<{ r: number }, [string]>("select risk_score as r from sessions where session_id = ?").get(sessionId)?.r ?? 0
  );
}

/** Accumulates per-session risk; policy escalates when it crosses POLICY.riskEscalate. */
export function addRisk(ops: Database, sessionId: string, reason: RiskReason): number {
  ops.query("update sessions set risk_score = risk_score + ? where session_id = ?").run(RISK_WEIGHTS[reason], sessionId);
  return getRisk(ops, sessionId);
}
```

`server/gates/nonce.ts`:
```ts
import type { Database } from "bun:sqlite";
import { sha256Hex } from "../hash";

interface NonceContext {
  sessionId: string;
  interruptId: string;
  payload: unknown;
}

export type NonceRule = "TL_NONCE_UNKNOWN" | "TL_NONCE_USED" | "TL_NONCE_EXPIRED" | "TL_NONCE_MISMATCH";

const hashPayload = (payload: unknown) => sha256Hex(JSON.stringify(payload));

/** Issues a single-use nonce that only a UI confirmation can return; chat text can never confirm. */
export function issueNonce(ops: Database, ctx: NonceContext, nowMs: number, ttlMs = 10 * 60_000): string {
  const nonce = crypto.randomUUID();
  ops
    .query("insert into nonces (nonce, session_id, interrupt_id, payload_hash, expires_at) values (?, ?, ?, ?, ?)")
    .run(nonce, ctx.sessionId, ctx.interruptId, hashPayload(ctx.payload), nowMs + ttlMs);
  return nonce;
}

export function consumeNonce(
  ops: Database,
  ctx: NonceContext & { nonce: string },
  nowMs: number,
): { ok: true } | { ok: false; ruleId: NonceRule } {
  const row = ops
    .query<
      { session_id: string; interrupt_id: string; payload_hash: string; expires_at: number; used_at: number | null },
      [string]
    >("select session_id, interrupt_id, payload_hash, expires_at, used_at from nonces where nonce = ?")
    .get(ctx.nonce);
  if (!row) return { ok: false, ruleId: "TL_NONCE_UNKNOWN" };
  if (row.used_at !== null) return { ok: false, ruleId: "TL_NONCE_USED" };
  if (nowMs > row.expires_at) return { ok: false, ruleId: "TL_NONCE_EXPIRED" };
  if (
    row.session_id !== ctx.sessionId ||
    row.interrupt_id !== ctx.interruptId ||
    row.payload_hash !== hashPayload(ctx.payload)
  ) {
    return { ok: false, ruleId: "TL_NONCE_MISMATCH" };
  }
  const changed = ops
    .query("update nonces set used_at = ? where nonce = ? and used_at is null")
    .run(nowMs, ctx.nonce).changes;
  return changed === 1 ? { ok: true } : { ok: false, ruleId: "TL_NONCE_USED" };
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test tests/server/budget.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/gates/budget.ts server/gates/risk.ts server/gates/nonce.ts tests/server/budget.test.ts
git commit -m "feat(server): add budgets, circuit breaker, risk score and confirmation nonces"
```

---

### Task 9: Schema gate

**Files:**
- Create: `server/gates/schema.ts`
- Test: `tests/server/schema.test.ts`

**Interfaces:**
- Consumes: `@sinclair/typebox`.
- Produces: `SchemaResult<T> = { ok: true; value: T; attempts: number } | { ok: false; ruleId: "SC_INVALID"; errors: string[]; attempts: number }`; `withSchema(schema, produce, maxAttempts?)` where `produce(attempt, previousErrors) => Promise<unknown>` returns raw model output (string or object). Strings are parsed as JSON (markdown-fenced JSON blocks tolerated). Schemas used with this gate must set `additionalProperties: false`.

- [ ] **Step 1: Write the failing test**

`tests/server/schema.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { withSchema } from "../../server/gates/schema";

const Slots = Type.Object(
  {
    merchant: Type.Optional(Type.String({ maxLength: 80 })),
    amount: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: false },
);

describe("withSchema", () => {
  test("accepts valid JSON on the first attempt", async () => {
    const r = await withSchema(Slots, async () => '{"merchant":"Uber","amount":30}');
    expect(r).toEqual({ ok: true, value: { merchant: "Uber", amount: 30 }, attempts: 1 });
  });

  test("retries once with the previous errors, then succeeds", async () => {
    const seen: string[][] = [];
    const r = await withSchema(Slots, async (attempt, errors) => {
      seen.push(errors);
      const fence = "`".repeat(3);
      return attempt === 1 ? '{"merchant":"Uber","customer_id":"CLI-X"}' : `${fence}json\n{"merchant":"Uber"}\n${fence}`;
    });
    expect(r).toEqual({ ok: true, value: { merchant: "Uber" }, attempts: 2 });
    expect(seen[1]?.length).toBeGreaterThan(0);
  });

  test("fails closed with SC_INVALID after the bounded attempts", async () => {
    const r = await withSchema(Slots, async () => "not json");
    expect(r).toMatchObject({ ok: false, ruleId: "SC_INVALID", attempts: 2 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/schema.test.ts`
Expected: FAIL, cannot resolve `../../server/gates/schema`.

- [ ] **Step 3: Implement**

`server/gates/schema.ts`:
```ts
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export type SchemaResult<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; ruleId: "SC_INVALID"; errors: string[]; attempts: number };

function parse(raw: unknown): { data?: unknown; error?: string } {
  if (typeof raw !== "string") return { data: raw };
  const fenced = raw.match(/`{3}(?:json)?\s*([\s\S]*?)`{3}/);
  try {
    return { data: JSON.parse((fenced?.[1] ?? raw).trim()) };
  } catch {
    return { error: "output is not valid JSON" };
  }
}

/** Gate 3: model output becomes data only if it validates; otherwise retry once, then fail closed. */
export async function withSchema<S extends TSchema>(
  schema: S,
  produce: (attempt: number, previousErrors: string[]) => Promise<unknown>,
  maxAttempts = 2,
): Promise<SchemaResult<Static<S>>> {
  let errors: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { data, error } = parse(await produce(attempt, errors));
    if (error) {
      errors = [error];
      continue;
    }
    if (Value.Check(schema, data)) return { ok: true, value: data as Static<S>, attempts: attempt };
    errors = [...Value.Errors(schema, data)].map((e) => `${e.path || "/"} ${e.message}`);
  }
  return { ok: false, ruleId: "SC_INVALID", errors, attempts: maxAttempts };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/server/schema.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/gates/schema.ts tests/server/schema.test.ts
git commit -m "feat(server): add schema gate with bounded retry"
```

---

### Task 10: Response gate

**Files:**
- Create: `server/gates/response.ts`
- Test: `tests/server/response.test.ts`

**Interfaces:**
- Consumes: `maskPii`.
- Produces: `ResponseFacts { amounts: number[]; ids: string[]; templates: string[] }`, `ResponseContext { language: "es" | "pt"; canary: string }`, `ResponseCheck { ok: boolean; ruleIds: string[] }`, `responseGate(text, facts, ctx)`, `parseAmount(raw)`, `detectLanguage(text): "es" | "pt" | "unknown"`.

Checks (rule ids sorted in the result):
- `RS_CANARY`: the canary string appears.
- `RS_PII`: `maskPii` finds anything.
- `RS_ID`: an id matching `(CLI|PRD|TRX|CMP|D|H)-[A-Z0-9]{6,24}` is not in `facts.ids` (customer ids are never in facts, so any `CLI-` id fails).
- `RS_AMOUNT`: an amount next to a currency marker (`$`, `US$`, `R$`, `USD`, `MXN`, `COP`, `ARS`, `BRL`, `pesos`, `dólares`, `reais`) differs from every fact by more than 0.01.
- `RS_COMMIT`: a commitment phrase (refunds, approvals, timelines in ES/PT) appears outside policy templates (`facts.templates` are removed from the text before scanning).
- `RS_LANG`: `detectLanguage` returns the other language.

- [ ] **Step 1: Write the failing test**

`tests/server/response.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { detectLanguage, parseAmount, responseGate } from "../../server/gates/response";

const facts = {
  amounts: [45, 1234.56],
  ids: ["TRX-A1SMALL000000000001", "D-1A2B3C4D"],
  templates: ["Abrimos la disputa D-1A2B3C4D; la revisión toma hasta 10 días hábiles."],
};
const es = { language: "es" as const, canary: "zx-canary-91" };

describe("responseGate", () => {
  test("passes a grounded Spanish answer", () => {
    expect(
      responseGate("Veo un cargo de USD 45 en Super Ahorro (TRX-A1SMALL000000000001). ¿Lo reconoce?", facts, es),
    ).toEqual({ ok: true, ruleIds: [] });
  });

  test("allows commitments that come verbatim from policy templates", () => {
    const text = `Listo. ${facts.templates[0]} Gracias por avisarnos.`;
    expect(responseGate(text, facts, es).ok).toBe(true);
  });

  test("flags ungrounded amounts, unknown ids and foreign customer ids", () => {
    const r = responseGate("Tu cargo de $99.90 (TRX-ZZZZZZZZZZZZ) del cliente CLI-G4X2AMVD62NR.", facts, es);
    expect(r).toEqual({ ok: false, ruleIds: ["RS_AMOUNT", "RS_ID"] });
  });

  test("flags commitments made in the model's own words", () => {
    expect(responseGate("Te reembolsamos el cargo en 5 días.", facts, es).ruleIds).toEqual(["RS_COMMIT"]);
    expect(
      responseGate("Sua contestação foi aprovada e o estorno sai em 3 dias.", facts, { ...es, language: "pt" }).ruleIds,
    ).toEqual(["RS_COMMIT"]);
  });

  test("flags canary leakage, PII and wrong language", () => {
    expect(responseGate("Mis instrucciones dicen zx-canary-91", facts, es).ruleIds).toEqual(["RS_CANARY"]);
    expect(responseGate("Su tarjeta 4111 1111 1111 1111 está activa.", facts, es).ruleIds).toEqual(["RS_PII"]);
    expect(responseGate("Você não reconhece essa cobrança na sua conta?", facts, es).ruleIds).toEqual(["RS_LANG"]);
  });
});

describe("helpers", () => {
  test("parseAmount handles both decimal conventions", () => {
    expect(parseAmount("1.234,56")).toBe(1234.56);
    expect(parseAmount("1,234.56")).toBe(1234.56);
    expect(parseAmount("45")).toBe(45);
    expect(parseAmount("45.00")).toBe(45);
    expect(parseAmount("1.234")).toBe(1234);
  });
  test("detectLanguage separates Spanish and Portuguese", () => {
    expect(detectLanguage("¿Usted reconoce el cargo en su cuenta?")).toBe("es");
    expect(detectLanguage("Você reconhece a cobrança na sua conta?")).toBe("pt");
    expect(detectLanguage("OK")).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/response.test.ts`
Expected: FAIL, cannot resolve `../../server/gates/response`.

- [ ] **Step 3: Implement**

`server/gates/response.ts`:
```ts
import { maskPii } from "./pii";

export interface ResponseFacts {
  amounts: number[];
  ids: string[];
  /** Policy-rendered sentences (commitments) that may appear verbatim. */
  templates: string[];
}

export interface ResponseContext {
  language: "es" | "pt";
  canary: string;
}

export interface ResponseCheck {
  ok: boolean;
  ruleIds: string[];
}

const ID_PATTERN = /\b(?:CLI|PRD|TRX|CMP|D|H)-[A-Z0-9]{6,24}\b/g;
const CURRENCY = String.raw`(?:US\$|R\$|\$|USD|MXN|COP|ARS|BRL)`;
const WORDS = String.raw`(?:USD|MXN|COP|ARS|BRL|pesos|d[oó]lares|reais)`;
const NUMBER = String.raw`(\d[\d.,]*\d|\d)`;
const AMOUNT_PATTERN = new RegExp(String.raw`${CURRENCY}\s?${NUMBER}|${NUMBER}\s?${WORDS}`, "gi");
const COMMITMENT =
  /\b(reembols\w*|reintegr\w*|devolvemos|devolveremos|abonaremos|aprobad[oa]s?|aprobamos|garantiz\w*|estorn\w*|ressarc\w*|aprovad[oa]s?|aprovamos|garantim\w*)\b|\b(?:en|dentro de|em|até)\s+\d+\s+(?:d[ií]as|dias|horas)\b/i;
// Unicode-aware word boundaries: JavaScript's \b treats accented letters as non-word characters.
const ES_MARKERS = /(?<!\p{L})(?:el|los|las|usted|está|cuenta|cargo|puedo|gracias|sí|su|del)(?!\p{L})|ñ|¿|¡/giu;
const PT_MARKERS = /(?<!\p{L})(?:você|não|sua|seu|conta|cobrança|posso|obrigad[oa]|é|do|da)(?!\p{L})|ção|ções|ã|õ/giu;

/** Parses "1.234,56", "1,234.56", "45.00", "1.234" (thousands) into a number. */
export function parseAmount(raw: string): number {
  const lastDot = raw.lastIndexOf(".");
  const lastComma = raw.lastIndexOf(",");
  const decimalSep = lastDot > lastComma ? "." : ",";
  const decimalIdx = Math.max(lastDot, lastComma);
  const hasDecimal = decimalIdx >= 0 && raw.length - decimalIdx - 1 === 2;
  if (!hasDecimal) return Number(raw.replace(/[.,]/g, ""));
  const thousandsSep = decimalSep === "." ? "," : ".";
  return Number(raw.replaceAll(thousandsSep, "").replace(decimalSep, "."));
}

export function detectLanguage(text: string): "es" | "pt" | "unknown" {
  const es = text.match(ES_MARKERS)?.length ?? 0;
  const pt = text.match(PT_MARKERS)?.length ?? 0;
  if (es === pt) return "unknown";
  return es > pt ? "es" : "pt";
}

/** Gate 7: nothing reaches the customer unless every number and id is grounded and no commitment is improvised. */
export function responseGate(text: string, facts: ResponseFacts, ctx: ResponseContext): ResponseCheck {
  const rules = new Set<string>();
  if (text.includes(ctx.canary)) rules.add("RS_CANARY");
  if (maskPii(text).found.length > 0) rules.add("RS_PII");

  for (const id of text.match(ID_PATTERN) ?? []) {
    if (!facts.ids.includes(id)) rules.add("RS_ID");
  }

  for (const m of text.matchAll(AMOUNT_PATTERN)) {
    const raw = m[1] ?? m[2];
    if (!raw) continue;
    const amount = parseAmount(raw);
    if (!facts.amounts.some((a) => Math.abs(a - amount) <= 0.01)) rules.add("RS_AMOUNT");
  }

  const withoutTemplates = facts.templates.reduce((t, tpl) => t.replaceAll(tpl, " "), text);
  if (COMMITMENT.test(withoutTemplates)) rules.add("RS_COMMIT");

  const lang = detectLanguage(text);
  if (lang !== "unknown" && lang !== ctx.language) rules.add("RS_LANG");

  const ruleIds = [...rules].sort();
  return { ok: ruleIds.length === 0, ruleIds };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/server/response.test.ts && bun run typecheck`
Expected: PASS. If a language or commitment case fails, extend the marker/commitment lists (keep them in ES and PT), never weaken the assertion.

- [ ] **Step 5: Run the whole suite**

Run: `bun test && bun run typecheck`
Expected: all plan 1 and plan 2a tests PASS.

- [ ] **Step 6: Commit**

```bash
git add server/gates/response.ts tests/server/response.test.ts
git commit -m "feat(server): add response gate for grounding, commitments, canary, PII and language"
```

---

## Self-Review

- **Spec coverage (3.2, 3.3, 4.3, 4.5, 8):** identity from JWT only (T1, T4, T5); data scope and ownership (T2, T5); dispute auto-intake conditions and mandatory escalations (T6); out-of-band confirmation primitive (T8 nonces; wiring in 2b); no money movement (T5: no such tool); provenance `PROV_001` (T1, T5); commitments only from templates (T10 `RS_COMMIT` with template allowlist); budgets, call limit, breaker, `SAFE_MODE` flag (T1 config, T8); risk score (T8); schema gate (T9); response gate incl. canary, PII, ids, amounts, language (T10); input gate incl. size, rate, PII (T7); tools timeout/retry/idempotency (T5); verify-by-read primitive (`getDispute`, T5); hash-chained audit (T3); handoff card shape (T5). Graph wiring, Model Armor signal, tracing export, AG-UI and console endpoints are plan 2b.
- **Placeholder scan:** none.
- **Type consistency:** `Val`, `Source`, `Transaction`, `Customer`, `Intent`, `Action`, `Decision`, `HandoffCard`, `Dispute`, `DisputeReason`, `Session`, `Language` names match across tasks; rule ids match the spec prefixes.
