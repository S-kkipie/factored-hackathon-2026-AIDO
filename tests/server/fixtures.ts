import { afterAll } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { type Sql, fromPglite, migrationSql } from "../../server/db/sql";

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

const f = FIXTURE;

/** The plan-1 serving contract, loaded into the `serving` schema. */
export const SERVING_FIXTURE_SQL = `
  insert into serving.customers values
    ('${f.normal}', 'Ana', 'López', 'México', 'Basic', 'Active', 'mexican', 'customers.csv', 'L1'),
    ('${f.suspended}', 'Juan', 'Pérez', 'Colombia', 'Plus', 'Suspended', 'colombian', 'customers.csv', 'L1'),
    ('${f.repeat}', 'Sofía', 'Gómez', 'Argentina', 'Premium', 'Active', null, 'customers.csv', 'L1');
  insert into serving.products values
    ('PRD-A1', '${f.normal}', 'Tarjeta Crédito', '****1111', 'USD', 1200.5, 5000, 'Active', 'products.csv', 'L1'),
    ('PRD-C1', '${f.repeat}', 'Cuenta Ahorro', '****2222', 'ARS', 800000, null, 'Active', 'products.csv', 'L1');
  insert into serving.transactions values
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
  insert into serving.complaints values
    ('CMP-C1', '${f.repeat}', '2026-06-01T10:00:00', 'Transactions', 'Cargo no reconocido', 'Open', 50, 'USD', 1, 'PRD-C1', 'c.csv', 'L1');
  insert into serving.demo_users values ('normal', '${f.normal}'), ('suspended', '${f.suspended}'), ('repeat_complainer', '${f.repeat}');
  insert into serving.meta values ('clock', '2026-06-17');
`;

/** Migrated + seeded once per test file; every test gets its own copy-on-write clone (~0.3 s vs ~2 s boot). */
let template: Promise<PGlite> | null = null;
const open: { close(): Promise<void> }[] = [];

const getTemplate = () => {
  template ??= (async () => {
    const pg = new PGlite();
    await pg.exec(migrationSql());
    await pg.exec(SERVING_FIXTURE_SQL);
    open.push(pg);
    return pg;
  })();
  return template;
};

afterAll(async () => {
  await Promise.all(open.splice(0).map((pg) => pg.close().catch(() => {})));
  template = null;
});

/** A fresh Postgres (PGlite) with the Supabase migrations and the serving fixture; `extraSql` runs on top. */
export async function makeDb(extraSql?: string): Promise<Sql> {
  const pg = (await (await getTemplate()).clone()) as PGlite;
  open.push(pg);
  if (extraSql) await pg.exec(extraSql);
  return fromPglite(pg);
}

/** A migrated database with an empty serving schema. */
export async function makeEmptyDb(): Promise<Sql> {
  const pg = new PGlite();
  open.push(pg);
  await pg.exec(migrationSql());
  return fromPglite(pg);
}
