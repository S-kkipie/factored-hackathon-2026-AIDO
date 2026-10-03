import { existsSync } from "node:fs";
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

    const transactionColumns = db.query<{ name: string }, []>("pragma table_info(transactions)").all().map((r) => r.name);
    expect(transactionColumns).not.toContain("is_fraud");

    expect(db.query("select product_number_masked as m from products where product_id = 'P1'").get()).toEqual({
      m: "****1111",
    });
    expect(db.query("select amount_usd as usd from transactions where transaction_id = 'T1'").get()).toEqual({
      usd: 45,
    });
    expect(db.query("select value from meta where key = 'clock'").get()).toEqual({ value: "2026-06-17" });
    db.close();
  });

  test("rejects if any persona is missing", async () => {
    const config = await makeWorkspace();
    const duck = await openDuck(":memory:");
    await ensureStagingSchema(duck);
    await stageAll(duck, config, "load-1");
    await duck.run("update stg.customers set customer_status = 'Active' where customer_status = 'Suspended'");

    await expect(curate(duck, config)).rejects.toThrow("missing demo personas: suspended");
    duck.close();

    expect(existsSync(config.servingPath)).toBe(false);
    expect(existsSync(`${config.servingPath}.tmp`)).toBe(false);
  });
});
