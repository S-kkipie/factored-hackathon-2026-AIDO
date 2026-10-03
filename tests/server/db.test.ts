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
