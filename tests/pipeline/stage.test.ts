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

  test("respects partition recency: newer partition data is not overwritten by older files", async () => {
    const config = await makeWorkspace();
    const duck = await openDuck(":memory:");
    await ensureStagingSchema(duck);

    // Initial load: T1 comes from day=11 with status Reversed (newer) and day=10 with status Approved (older)
    await stageTable(duck, transactions, await listSourceFiles(config.rawDir, transactions.files), config.rawDir, "load-1");
    const t1After = await duck.one<Record<string, unknown>>(
      "select transaction_status, source_file from stg.transactions where transaction_id = 'T1'",
    );
    expect(t1After.transaction_status).toBe("Reversed");
    expect(t1After.source_file).toContain("day=11");

    // Rewrite day=10 file with T8 added (change size so it's re-loaded)
    await Bun.write(
      join(config.rawDir, "transactions/year=2026/month=06/day=10/transactions_20260610.csv"),
      `${TX_HEADER}\nT1,2026-06-10 12:00:00,2026-06-10,P1,C1,Purchase,Food,45.00,USD,,POS,Super Ahorro,Food,Mexico,CDMX,Approved,00,False,12.5\nT2,2026-06-10 13:00:00,2026-06-10,P1,C1,Purchase,Other,300.00,USD,,Web,Boutique Moda,Other,México,CDMX,Approved,00,False,88.0\nT3,2026-06-10 14:00:00,2026-06-10,P3,C3,Purchase,Entertainment,900000,ARS,950.00,POS,Teatro Nacional,Entertainment,Argentina,Buenos Aires,Approved,00,False,5.0\nT4,2026-06-10 15:00:00,2026-06-10,P2,C2,Withdrawal,,200000,COP,48.00,ATM,,,Colombia,Bogotá,Approved,00,False,3.0\nTX,not-a-date,2026-06-10,P1,C1,Purchase,Food,10,USD,,POS,Super Ahorro,Food,México,CDMX,Approved,00,False,1.0\nT8,2026-06-10 16:00:00,2026-06-10,P1,C1,Purchase,Food,50.00,USD,,POS,Mercado Local,Food,México,CDMX,Approved,00,False,6.0\n`,
    );

    // Re-load: should pick up T8 as new, T2-T4 same-file updates, but NOT overwrite T1 with day=10's status
    const rerun = await stageTable(
      duck,
      transactions,
      await listSourceFiles(config.rawDir, transactions.files),
      config.rawDir,
      "load-2",
    );
    expect(rerun).toMatchObject({ filesLoaded: 1, inserted: 1, updated: 3 });

    // Verify T1 still has status from day=11
    const t1Final = await duck.one<Record<string, unknown>>(
      "select transaction_status, source_file from stg.transactions where transaction_id = 'T1'",
    );
    expect(t1Final.transaction_status).toBe("Reversed");
    expect(t1Final.source_file).toContain("day=11");

    // Verify T8 was inserted
    const t8 = await duck.one<Record<string, unknown>>(
      "select transaction_id, source_file from stg.transactions where transaction_id = 'T8'",
    );
    expect(t8.transaction_id).toBe("T8");
    expect(t8.source_file).toContain("day=10");

    // The day=10 file still contains the invalid TX row on every reload; rejects for that
    // source file must be replaced, not accumulated, across reloads.
    const txRejects = await duck.one<{ n: number }>("select count(*)::integer as n from stg._rejects where pk = 'TX'");
    expect(txRejects.n).toBe(1);

    duck.close();
  });

  test("same-file re-load applies corrections", async () => {
    const config = await makeWorkspace();
    const duck = await openDuck(":memory:");
    await ensureStagingSchema(duck);

    // Initial load
    await stageTable(duck, transactions, await listSourceFiles(config.rawDir, transactions.files), config.rawDir, "load-1");
    const t6Before = await duck.one<Record<string, unknown>>(
      "select transaction_status, source_file from stg.transactions where transaction_id = 'T6'",
    );
    expect(t6Before.transaction_status).toBe("Approved");

    // Rewrite day=11 file in place: correct T6's status from Approved to Reversed (add extra newline to change size)
    await Bun.write(
      join(config.rawDir, "transactions/year=2026/month=06/day=11/transactions_20260611.csv"),
      `${TX_HEADER}\nT1,2026-06-10 12:00:00,2026-06-11,P1,C1,Purchase,Food,45.00,USD,,POS,Super Ahorro,Food,Mexico,CDMX,Reversed,00,False,12.5\nT5,2025-01-05 09:00:00,2026-06-11,P1,C1,Purchase,Health,20.00,USD,,POS,Farmacia Salud,Health,México,CDMX,Approved,00,False,2.0\nT6,2026-06-11 09:00:00,2026-06-11,P1,C1,Purchase,Health,30.00,USD,,POS,Farmacia Salud,Health,México,CDMX,Reversed,00,False,4.0\n\n`,
    );

    // Re-load with corrected file: T1, T5, T6 are all updated (same source_file)
    const reload = await stageTable(
      duck,
      transactions,
      await listSourceFiles(config.rawDir, transactions.files),
      config.rawDir,
      "load-2",
    );
    expect(reload).toMatchObject({ filesLoaded: 1, inserted: 0, updated: 3 });

    // Verify T6 has corrected status
    const t6After = await duck.one<Record<string, unknown>>(
      "select transaction_status, source_file from stg.transactions where transaction_id = 'T6'",
    );
    expect(t6After.transaction_status).toBe("Reversed");
    expect(t6After.source_file).toContain("day=11");

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
