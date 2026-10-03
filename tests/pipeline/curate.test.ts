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

  test("creates serving indexes for common query patterns", async () => {
    const config = await makeWorkspace();
    const duck = await openDuck(":memory:");
    await ensureStagingSchema(duck);
    await stageAll(duck, config, "load-1");
    await curate(duck, config);
    duck.close();

    const db = new Database(config.servingPath, { readonly: true });
    const indexNames = db
      .query<{ name: string }, []>("select name from sqlite_master where type = 'index'")
      .all()
      .map((r) => r.name);
    for (const name of [
      "idx_transactions_customer_date",
      "idx_products_customer",
      "idx_complaints_customer",
      "idx_demo_users_persona",
    ]) {
      expect(indexNames).toContain(name);
    }
    db.close();
  });

  test("serving contract: demo_users count, meta keys, complaint flag type, transaction_date format", async () => {
    const config = await makeWorkspace();
    const duck = await openDuck(":memory:");
    await ensureStagingSchema(duck);
    await stageAll(duck, config, "load-1");
    await curate(duck, config);
    duck.close();

    const db = new Database(config.servingPath, { readonly: true });

    const demoUserCount = db.query<{ n: number }, []>("select count(*) as n from demo_users").get();
    expect(demoUserCount?.n).toBe(5);

    const metaKeys = db
      .query<{ key: string }, []>("select key from meta order by key")
      .all()
      .map((r) => r.key);
    expect(metaKeys).toEqual(["built_at", "clock", "window_days"]);

    const complaintFlag = db
      .query<{ v: unknown }, []>("select is_repeat_complainer as v from complaints where complaint_id = 'Q1'")
      .get();
    expect(typeof complaintFlag?.v).toBe("number");
    expect(complaintFlag?.v === 0 || complaintFlag?.v === 1).toBe(true);

    const txDates = db
      .query<{ d: string }, []>("select transaction_date as d from transactions")
      .all()
      .map((r) => r.d);
    expect(txDates.length).toBeGreaterThan(0);
    for (const d of txDates) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);

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
