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
  `);
  w.close();
  return new Database(path, { readonly: true });
}

describe("selectors", () => {
  test("auto-disputable picks only clean, in-window, unique-merchant, small, low-fraud approved transactions", () => {
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
