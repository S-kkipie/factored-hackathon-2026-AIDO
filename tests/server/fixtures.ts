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
