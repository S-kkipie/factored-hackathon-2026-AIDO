import { describe, expect, test } from "bun:test";
import { openServing } from "../../server/db/serving";
import { FIXTURE, makeDb } from "./fixtures";

describe("openServing", () => {
  const serving = makeDb().then(openServing);

  test("scopes transaction lookups to the customer", async () => {
    const s = await serving;
    expect((await s.transaction(FIXTURE.normal, FIXTURE.txSmall))?.merchant_name).toBe("Super Ahorro");
    expect(await s.transaction(FIXTURE.normal, FIXTURE.txOther)).toBeNull();
  });

  test("filters transactions by merchant and amount, newest first", async () => {
    const s = await serving;
    const byMerchant = (await s.transactions(FIXTURE.normal, { merchant: "ahorro" })).map((t) => t.transaction_id);
    expect(byMerchant).toEqual([FIXTURE.txPending, FIXTURE.txSmall]);
    const large = (await s.transactions(FIXTURE.normal, { minUsd: 500 })).map((t) => t.transaction_id);
    expect(large).toEqual([FIXTURE.txLarge]);
    const june = await s.transactions(FIXTURE.normal, { from: "2026-06-11", to: "2026-06-13" });
    expect(june.map((t) => t.transaction_id)).toEqual([FIXTURE.txFraud, FIXTURE.txLarge]);
  });

  test("returns products, complaints and demo users with numeric types intact", async () => {
    const s = await serving;
    const [product] = await s.products(FIXTURE.normal);
    expect(product?.product_number_masked).toBe("****1111");
    expect(product?.current_balance).toBe(1200.5);
    expect((await s.complaints(FIXTURE.repeat))[0]?.is_repeat_complainer).toBe(1);
    expect((await s.demoUsers()).map((d) => d.persona).sort()).toEqual(["normal", "repeat_complainer", "suspended"]);
    expect((await s.customer(FIXTURE.suspended))?.customer_status).toBe("Suspended");
  });
});

describe("migrations", () => {
  test("create the operational and serving tables in their own schemas", async () => {
    const db = await makeDb();
    const rows = await db.all<{ name: string }>(
      "select table_schema || '.' || table_name as name from information_schema.tables where table_schema in ('ops', 'serving') order by 1",
    );
    expect(rows.map((r) => r.name)).toEqual(
      expect.arrayContaining([
        "ops.audit_events",
        "ops.checkpoints",
        "ops.disputes",
        "ops.handoffs",
        "ops.nonces",
        "ops.rate_events",
        "ops.sessions",
        "ops.spans",
        "ops.spend",
        "serving.customers",
        "serving.transactions",
      ]),
    );
  });

  test("are idempotent and enable row level security", async () => {
    const db = await makeDb();
    const { migrate } = await import("../../server/db/sql");
    await migrate(db);
    const open = await db.all<{ t: string }>(
      "select schemaname || '.' || tablename as t from pg_tables where schemaname in ('ops', 'serving') and not rowsecurity",
    );
    expect(open).toEqual([]);
  });
});
