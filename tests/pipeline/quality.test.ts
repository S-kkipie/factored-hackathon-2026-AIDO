import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { customers, products, transactions } from "../../pipeline/contracts";
import { openDuck } from "../../pipeline/duck";
import { buildMarts, renderDemandMarkdown } from "../../pipeline/marts";
import { assessTable, loadHistory, renderQualityMarkdown } from "../../pipeline/quality";
import { ensureStagingSchema, stageTable } from "../../pipeline/stage";
import { TX_HEADER, makeWorkspace, stageAll } from "./helpers";

async function staged() {
  const config = await makeWorkspace();
  const duck = await openDuck(":memory:");
  await ensureStagingSchema(duck);
  const stages = await stageAll(duck, config, "load-1");
  return { config, duck, stages };
}

describe("assessTable", () => {
  test("reports rejects, nulls, orphans, duplicates and arrival lag", async () => {
    const { duck } = await staged();
    const c = await assessTable(duck, customers);
    expect(c).toMatchObject({
      table: "customers",
      stagedRows: 3,
      documentedRows: 150_000,
      rejectsByReason: [{ reason: "enum:segment", n: 1 }],
      contentDuplicates: 0,
      lagDays: null,
    });
    expect(c.nullRates).toEqual([{ column: "detected_accent", pct: 33.33 }]);

    const p = await assessTable(duck, products);
    expect(p.orphans).toEqual([{ column: "customer_id", references: "customers.customer_id", n: 1 }]);

    const t = await assessTable(duck, transactions);
    expect(t.nullRates).toContainEqual({ column: "transaction_category", pct: 16.67 });
    expect(t.lagDays?.max).toBe(522);

    const history = await loadHistory(duck);
    const md = renderQualityMarkdown([c, p, t], history, "run-x");
    expect(md).toContain("Run: `run-x`");
    expect(md).toContain("## Load summary (all runs)");
    expect(md).toContain("## customers");
    expect(md).toContain("| enum:segment | 1 |");
    duck.close();
  });

  test("handles empty tables without null lag stats", async () => {
    const duck = await openDuck(":memory:");
    await ensureStagingSchema(duck);
    await stageTable(duck, customers, [], "/tmp", "load-1");
    await stageTable(duck, products, [], "/tmp", "load-1");
    await stageTable(duck, transactions, [], "/tmp", "load-1");
    const q = await assessTable(duck, transactions);
    expect(q).toMatchObject({
      table: "transactions",
      stagedRows: 0,
      lagDays: null,
    });
    const md = renderQualityMarkdown([q], [], "r");
    expect(md).not.toContain("Arrival lag");
    duck.close();
  });
});

describe("loadHistory", () => {
  test("aggregates load statistics across multiple runs in one workspace", async () => {
    const config = await makeWorkspace();
    const duck = await openDuck(":memory:");
    await ensureStagingSchema(duck);

    const firstRun = await stageAll(duck, config, "load-1");
    const firstTx = firstRun.find((s) => s.table === "transactions");
    if (!firstTx) throw new Error("transactions stage result missing from first run");

    // Second run: a brand-new, late-arriving partition file for transactions only.
    await Bun.write(
      join(config.rawDir, "transactions/year=2026/month=06/day=09/transactions_20260609.csv"),
      `${TX_HEADER}\nT7,2026-06-09 08:00:00,2026-06-09,P3,C3,Payment,Services,1000,ARS,1.05,App,Internet Plus,Services,Argentina,Rosario,Approved,00,False,1.0\n`,
    );
    const secondRun = await stageAll(duck, config, "load-2");
    const secondTx = secondRun.find((s) => s.table === "transactions");
    if (!secondTx) throw new Error("transactions stage result missing from second run");
    expect(secondTx.filesLoaded).toBe(1);

    const history = await loadHistory(duck);
    const txHistory = history.find((h) => h.table === "transactions");
    expect(txHistory).toMatchObject({
      filesLoaded: firstTx.filesLoaded + secondTx.filesLoaded,
      rowsRead: firstTx.rowsRead + secondTx.rowsRead,
      rejected: firstTx.rejected + secondTx.rejected,
      duplicatesInBatch: firstTx.duplicatesInBatch + secondTx.duplicatesInBatch,
      inserted: firstTx.inserted + secondTx.inserted,
      updated: firstTx.updated + secondTx.updated,
    });

    // Tables untouched by the second run still only contributed the first run's totals.
    const customersFirst = firstRun.find((s) => s.table === "customers");
    const customersHistory = history.find((h) => h.table === "customers");
    expect(customersHistory?.filesLoaded).toBe(customersFirst?.filesLoaded);

    duck.close();
  });
});

describe("buildMarts", () => {
  test("writes parquet marts and returns rows", async () => {
    const { config, duck } = await staged();
    const marts = await buildMarts(duck, config.martsDir);
    expect(marts.contact_mix).toEqual([
      { reason_category: "Transaccional", n: 2, pct: 66.7, fcr_pct: 100, escalation_pct: 0, avg_duration_s: 200 },
      { reason_category: "Queja", n: 1, pct: 33.3, fcr_pct: 0, escalation_pct: 100, avg_duration_s: 450 },
    ]);
    expect(existsSync(join(config.martsDir, "contact_mix.parquet"))).toBe(true);
    expect(renderDemandMarkdown(marts)).toContain("## contact_mix");
    duck.close();
  });
});
