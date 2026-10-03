import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { customers, transactions } from "../../pipeline/contracts";
import { openDuck } from "../../pipeline/duck";
import { ensureStagingSchema, listSourceFiles, stageTable } from "../../pipeline/stage";
import { TX_HEADER, makeWorkspace } from "./helpers";

describe("stageTable", () => {
  test("loads valid rows and quarantines contract violations", async () => {
    const config = await makeWorkspace();
    const duck = await openDuck(":memory:");
    await ensureStagingSchema(duck);
    const files = await listSourceFiles(config.rawDir, customers.files);
    const result = await stageTable(duck, customers, files, config.rawDir, "load-1");
    expect(result).toMatchObject({ filesLoaded: 1, rowsRead: 4, rejected: 1, inserted: 3, updated: 0 });
    expect(await duck.all("select pk, reasons, source_file from stg._rejects")).toEqual([
      { pk: "C4", reasons: "enum:segment", source_file: "customers.csv" },
    ]);
    duck.close();
  });

  test("dedups within a batch (latest file wins) and normalizes values", async () => {
    const config = await makeWorkspace();
    const duck = await openDuck(":memory:");
    await ensureStagingSchema(duck);
    const files = await listSourceFiles(config.rawDir, transactions.files);
    const result = await stageTable(duck, transactions, files, config.rawDir, "load-1");
    expect(result).toMatchObject({
      filesLoaded: 2,
      rowsRead: 8,
      rejected: 1,
      duplicatesInBatch: 1,
      inserted: 6,
      updated: 0,
      missingColumns: [],
      unexpectedColumns: [],
    });
    expect(
      await duck.one<Record<string, unknown>>(
        "select transaction_status, transaction_country, source_file, load_id from stg.transactions where transaction_id = 'T1'",
      ),
    ).toEqual({
      transaction_status: "Reversed",
      transaction_country: "México",
      source_file: "transactions/year=2026/month=06/day=11/transactions_20260611.csv",
      load_id: "load-1",
    });
    expect(await duck.all("select pk, reasons from stg._rejects")).toEqual([
      { pk: "TX", reasons: "type:transaction_date" },
    ]);
    duck.close();
  });

  test("incremental: unchanged files are skipped; late partitions and corrections are applied", async () => {
    const config = await makeWorkspace();
    const duck = await openDuck(":memory:");
    await ensureStagingSchema(duck);
    await stageTable(duck, transactions, await listSourceFiles(config.rawDir, transactions.files), config.rawDir, "load-1");

    const rerun = await stageTable(
      duck,
      transactions,
      await listSourceFiles(config.rawDir, transactions.files),
      config.rawDir,
      "load-2",
    );
    expect(rerun.filesLoaded).toBe(0);

    // Labeled fixture: a late-arriving older partition (new row T7) and a correction to T2.
    await Bun.write(
      join(config.rawDir, "transactions/year=2026/month=06/day=09/transactions_20260609.csv"),
      `${TX_HEADER}\nT7,2026-06-09 08:00:00,2026-06-09,P3,C3,Payment,Services,1000,ARS,1.05,App,Internet Plus,Services,Argentina,Rosario,Approved,00,False,1.0\n`,
    );
    await Bun.write(
      join(config.rawDir, "transactions/year=2026/month=06/day=12/transactions_20260612.csv"),
      `${TX_HEADER}\nT2,2026-06-10 13:00:00,2026-06-12,P1,C1,Purchase,Other,300.00,USD,,Web,Boutique Moda,Other,México,CDMX,Reversed,00,False,88.0\n`,
    );
    const late = await stageTable(
      duck,
      transactions,
      await listSourceFiles(config.rawDir, transactions.files),
      config.rawDir,
      "load-3",
    );
    expect(late).toMatchObject({ filesLoaded: 2, rowsRead: 2, inserted: 1, updated: 1 });
    expect(await duck.one<Record<string, unknown>>("select count(*)::integer as n from stg.transactions")).toEqual({ n: 7 });
    expect(
      await duck.one<Record<string, unknown>>("select transaction_status, load_id from stg.transactions where transaction_id = 'T2'"),
    ).toEqual({ transaction_status: "Reversed", load_id: "load-3" });
    duck.close();
  });

  test("reports schema drift", async () => {
    const config = await makeWorkspace();
    await Bun.write(
      join(config.rawDir, "customers.csv"),
      "customer_id,document_type,first_name,last_name,country,segment,customer_status,registration_date,last_updated,favorite_color\nC1,DNI,Ana,Lopez,México,Basic,Active,2024-01-01 10:00:00,2026-06-01 10:00:00,blue\n",
    );
    const duck = await openDuck(":memory:");
    await ensureStagingSchema(duck);
    const result = await stageTable(
      duck,
      customers,
      await listSourceFiles(config.rawDir, customers.files),
      config.rawDir,
      "load-1",
    );
    expect(result.missingColumns).toEqual(["detected_accent"]);
    expect(result.unexpectedColumns).toEqual(["favorite_color"]);
    expect(result.inserted).toBe(1);
    duck.close();
  });
});
