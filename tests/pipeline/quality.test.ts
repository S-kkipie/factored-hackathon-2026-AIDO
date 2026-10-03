import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { customers, products, transactions } from "../../pipeline/contracts";
import { openDuck } from "../../pipeline/duck";
import { buildMarts, renderDemandMarkdown } from "../../pipeline/marts";
import { assessTable, renderQualityMarkdown } from "../../pipeline/quality";
import { ensureStagingSchema } from "../../pipeline/stage";
import { makeWorkspace, stageAll } from "./helpers";

async function staged() {
  const config = await makeWorkspace();
  const duck = await openDuck(":memory:");
  await ensureStagingSchema(duck);
  const stages = await stageAll(duck, config, "load-1");
  return { config, duck, stages };
}

describe("assessTable", () => {
  test("reports rejects, nulls, orphans, duplicates and arrival lag", async () => {
    const { duck, stages } = await staged();
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

    const md = renderQualityMarkdown([c, p, t], stages, "run-x");
    expect(md).toContain("Run: `run-x`");
    expect(md).toContain("## customers");
    expect(md).toContain("| enum:segment | 1 |");
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
