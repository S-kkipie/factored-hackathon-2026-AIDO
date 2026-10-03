import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { COLUMNS, buildDemoServing, seedDemo } from "../../pipeline/demo";
import { publishServing } from "../../pipeline/publish";
import { openServing } from "../../server/db/serving";
import { decide } from "../../server/policy/rules";
import { val } from "../../server/provenance";
import { makeEmptyDb } from "./fixtures";

describe("demo seed", () => {
  test("is deterministic and covers the five demo personas", () => {
    const a = buildDemoServing();
    const b = buildDemoServing();
    expect(a.transactions).toEqual(b.transactions);
    expect(a.demoUsers.map((r) => r[0]).sort()).toEqual(["fraud_suspect", "high_amount", "normal", "repeat_complainer", "suspended"]);
  });

  test("each persona exercises its policy path", async () => {
    const db = await makeEmptyDb();
    await seedDemo(db);
    const serving = openServing(db);
    const personas = Object.fromEntries((await serving.demoUsers()).map((u) => [u.persona, u.customer_id]));
    const decideFor = async (persona: string, merchant: string, usd: number) => {
      const customerId = personas[persona]!;
      const customer = (await serving.customer(customerId))!;
      const tx = (await serving.transactions(customerId, { merchant })).find(
        (t) => t.transaction_status === "Approved" && t.amount_usd === usd,
      );
      return decide({
        intent: "dispute_charge",
        customer,
        targets: [val(tx!, "db")],
        disputedTransactionIds: [],
        repeatComplainer: (await serving.complaints(customerId)).some((c) => c.is_repeat_complainer === 1),
        riskScore: 0,
      });
    };
    expect((await decideFor("normal", "Super Ahorro", 45)).action).toBe("confirm");
    expect((await decideFor("high_amount", "Boutique Moda", 700)).ruleIds).toContain("POL_DSP_AMOUNT");
    expect((await decideFor("fraud_suspect", "Moto Rápida", 30)).ruleIds).toContain("POL_DSP_FRAUD");
    expect((await decideFor("repeat_complainer", "Super Ahorro", 45)).ruleIds).toContain("POL_REPEAT");
    expect((await serving.customer(personas.suspended!))?.customer_status).toBe("Suspended");
  });

  test("publish copies a pipeline serving.sqlite into Postgres", async () => {
    const data = buildDemoServing(8);
    const path = join(mkdtempSync(join(tmpdir(), "aido-publish-")), "serving.sqlite");
    const src = new Database(path, { create: true });
    const tables: [keyof typeof COLUMNS, unknown[][]][] = [
      ["customers", data.customers],
      ["products", data.products],
      ["transactions", data.transactions],
      ["complaints", data.complaints],
      ["demo_users", data.demoUsers],
      ["meta", data.meta],
    ];
    for (const [t, rows] of tables) {
      src.exec(`create table ${t} (${COLUMNS[t].join(", ")})`);
      const ins = src.prepare(`insert into ${t} values (${COLUMNS[t].map(() => "?").join(", ")})`);
      for (const r of rows) ins.run(...(r as never[]));
    }
    src.close();

    const db = await makeEmptyDb();
    const counts = await publishServing(db, path);
    expect(counts.transactions).toBe(data.transactions.length);
    expect(counts.demo_users).toBe(5);
    // Re-publishing replaces, never duplicates.
    await publishServing(db, path);
    expect((await db.one<{ n: number }>("select count(*)::int as n from serving.customers"))?.n).toBe(8);
  });
});
