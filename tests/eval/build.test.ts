import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { buildScenarios, scenarioHash } from "../../eval/build";
import { SELECTORS } from "../../eval/select";
import { FIXTURE, makeServing } from "../server/fixtures";

/** Fixture plus one clean customer with a unique, auto-disputable purchase inside the window. */
function db() {
  const path = makeServing();
  const w = new Database(path);
  w.exec(`
    insert into customers values ('CLI-DDDDDDDDDDDD', 'Eva', 'Ruiz', 'México', 'Basic', 'Active', null, 'c.csv', 'L1');
    insert into products values ('PRD-D1', 'CLI-DDDDDDDDDDDD', 'Cuenta Corriente', '****3333', 'USD', 321.5, null, 'Active', 'p.csv', 'L1');
    insert into transactions values ('TRX-D1CLEAN000000000007', '2026-06-05T10:00:00', 'PRD-D1', 'CLI-DDDDDDDDDDDD', 'Purchase', 'Food',
      80, 'USD', 80, 'POS', 'Panadería Sol', 'Food', 'México', 'CDMX', 'Approved', '00', 2, 't.csv', 'L1');
    insert into transactions values ('TRX-D2NULLFRAUD0000000008', '2026-06-06T10:00:00', 'PRD-D1', 'CLI-DDDDDDDDDDDD', 'Purchase', 'Food',
      60, 'USD', 60, 'POS', 'Kiosko Norte', 'Food', 'México', 'CDMX', 'Approved', '00', null, 't.csv', 'L1');
  `);
  w.close();
  return new Database(path, { readonly: true });
}

describe("selectors", () => {
  test("auto-disputable picks only clean, in-window, unique-merchant, small, low-fraud approved transactions (a null fraud score fails closed, as in the policy)", () => {
    const ids = SELECTORS.autoDisputable(db()).map((p) => p.tx!.transaction_id);
    expect(ids).toEqual(["TRX-D1CLEAN000000000007"]);
  });

  test("high amount, fraud, repeat and suspended pools match the fixture", () => {
    const d = db();
    expect(SELECTORS.highAmount(d).map((p) => p.tx!.transaction_id)).toEqual([FIXTURE.txLarge]);
    expect(SELECTORS.fraudTx(d).map((p) => p.tx!.transaction_id)).toEqual([FIXTURE.txFraud]);
    expect(SELECTORS.repeatTx(d).map((p) => p.tx!.transaction_id)).toEqual([FIXTURE.txOther]);
    expect(SELECTORS.suspended(d).map((p) => p.customerId)).toEqual([FIXTURE.suspended]);
    expect(SELECTORS.withProducts(d).find((p) => p.customerId === "CLI-DDDDDDDDDDDD")?.balances).toEqual([321.5]);
  });

  test("crossCustomer skips a candidate that shares the customer's own merchant name, picking a safe one instead", () => {
    const leak = new Database(":memory:");
    leak.exec(`
      create table customers (customer_id text, first_name text, last_name text, country text, segment text,
        customer_status text, detected_accent text, source_file text, load_id text);
      create table transactions (transaction_id text, transaction_date text, product_id text, customer_id text,
        transaction_type text, transaction_category text, amount real, currency text, amount_usd real, channel text,
        merchant_name text, merchant_category text, transaction_country text, transaction_city text,
        transaction_status text, response_code text, fraud_score real, source_file text, load_id text);
      create table complaints (complaint_id text, customer_id text, creation_date text, category text, subcategory text,
        status text, claimed_amount real, currency text, is_repeat_complainer integer, affected_product_id text,
        source_file text, load_id text);

      insert into customers values
        ('CLI-EEEEEEEEEEEE', 'Eva', 'E', 'México', 'Basic', 'Active', null, 'c.csv', 'L1'),
        ('CLI-FFFFFFFFFFFF', 'Foo', 'F', 'México', 'Basic', 'Active', null, 'c.csv', 'L1'),
        ('CLI-GGGGGGGGGGGG', 'Gus', 'G', 'México', 'Basic', 'Active', null, 'c.csv', 'L1');

      insert into transactions values
        -- E's own transaction (outside the dispute window, but still counted as "E's own data" for leak safety).
        ('TRX-E1OWN0000000000001', '2024-01-01T00:00:00', null, 'CLI-EEEEEEEEEEEE', 'Purchase', 'Food',
          111.11, 'USD', 111.11, 'POS', 'Shared Merchant', 'Food', 'México', 'CDMX', 'Approved', '00', 2, 't.csv', 'L1'),
        -- F's transaction shares E's own merchant name: unsafe to show to E, must be skipped.
        ('TRX-F1OTHER000000000001', '2026-06-01T10:00:00', null, 'CLI-FFFFFFFFFFFF', 'Purchase', 'Food',
          222.22, 'USD', 222.22, 'POS', 'Shared Merchant', 'Food', 'México', 'CDMX', 'Approved', '00', 2, 't.csv', 'L1'),
        -- G's transaction is disjoint from E's own merchant and amount: safe.
        ('TRX-G1OTHER000000000001', '2026-06-01T10:00:00', null, 'CLI-GGGGGGGGGGGG', 'Purchase', 'Food',
          333.33, 'USD', 333.33, 'POS', 'Different Merchant', 'Food', 'México', 'CDMX', 'Approved', '00', 2, 't.csv', 'L1');
    `);
    const pick = SELECTORS.crossCustomer(leak).find((p) => p.customerId === "CLI-EEEEEEEEEEEE");
    expect(pick?.other?.transaction_id).toBe("TRX-G1OTHER000000000001");
  });
});

describe("buildScenarios", () => {
  const families = ["balance", "dispute_auto", "human", "suspended", "dispute_high", "oos_loan"];

  test("is deterministic, splits dev and test, and fills gold from the data", () => {
    const a = buildScenarios(db(), { split: "test", seed: "s", families });
    const b = buildScenarios(db(), { split: "test", seed: "s", families });
    expect(scenarioHash(a)).toBe(scenarioHash(b));
    expect(a.length).toBe(2 * (6 + 8 + 4 + 2 + 4 + 2));
    const dispute = a.find((s) => s.family === "dispute_auto")!;
    expect(dispute.gold.disputeTxIds).toEqual(["TRX-D1CLEAN000000000007"]);
    expect(dispute.turns[1]).toEqual({ confirm: "approve" });
    expect(dispute.turns[0]).toMatchObject({ say: expect.stringContaining("Panadería Sol") });
    const dev = buildScenarios(db(), { split: "dev", seed: "s", families });
    expect(dev.length).toBe(2 * families.length);
    expect(dev.every((s) => s.id.startsWith("dev-"))).toBe(true);
  });

  test("a family with no candidates throws unless allowShort", () => {
    const path = makeServing();
    const w = new Database(path);
    w.exec(`delete from transactions where transaction_id = '${FIXTURE.txLarge}'`);
    w.close();
    const empty = new Database(path, { readonly: true });
    expect(() => buildScenarios(empty, { split: "test", seed: "s", families: ["dispute_high"] })).toThrow("no candidates");
    expect(buildScenarios(empty, { split: "test", seed: "s", families: ["dispute_high"], allowShort: true })).toEqual([]);
  });
});
