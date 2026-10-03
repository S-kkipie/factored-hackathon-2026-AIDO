import { describe, expect, test } from "bun:test";
import { CONTRACTS } from "../../pipeline/contracts";
import { type Contract, col } from "../../pipeline/contracts/types";
import { openDuck } from "../../pipeline/duck";
import { typedSelectSql } from "../../pipeline/validate";

const contract: Contract = {
  table: "t",
  files: "t.csv",
  primaryKey: "id",
  documentedRows: 0,
  columns: [
    col("id", "VARCHAR"),
    col("amount", "DOUBLE"),
    col("status", "VARCHAR", false, { enum: ["A", "B"] }),
    col("country", "VARCHAR", true, { normalize: "case when {v} = 'Mexico' then 'México' else {v} end" }),
  ],
};

describe("typedSelectSql", () => {
  test("casts, normalizes and lists reject reasons in column order", async () => {
    const duck = await openDuck(":memory:");
    await duck.run(`create temp table _batch as select * from (values
      ('1', '10.5', 'A', 'Mexico', 'f1'),
      ('2', 'abc', 'A', ' ', 'f1'),
      (null, '1', 'Z', 'Peru', 'f2')
    ) v(id, amount, status, country, source_file)`);
    const sql = typedSelectSql(contract, new Set(["id", "amount", "status", "country"]));
    const rows = await duck.all(`select * from (${sql}) order by id nulls last`);
    expect(rows).toEqual([
      { id: "1", amount: 10.5, status: "A", country: "México", _reasons: "", source_file: "f1" },
      { id: "2", amount: null, status: "A", country: null, _reasons: "type:amount", source_file: "f1" },
      { id: null, amount: 1, status: "Z", country: "Peru", _reasons: "null:id;enum:status", source_file: "f2" },
    ]);
    duck.close();
  });

  test("treats columns absent from the batch as null", async () => {
    const duck = await openDuck(":memory:");
    await duck.run(`create temp table _batch as select * from (values ('1', '2', 'B', 'f1')) v(id, amount, status, source_file)`);
    const rows = await duck.all(`${typedSelectSql(contract, new Set(["id", "amount", "status"]))}`);
    expect(rows).toEqual([{ id: "1", amount: 2, status: "B", country: null, _reasons: "", source_file: "f1" }]);
    duck.close();
  });
});

describe("CONTRACTS", () => {
  test("primary keys and foreign keys reference declared columns and tables", () => {
    const tables = new Map(CONTRACTS.map((c) => [c.table, c]));
    for (const c of CONTRACTS) {
      const names = new Set(c.columns.map((x) => x.name));
      expect(names.has(c.primaryKey)).toBe(true);
      for (const fk of c.foreignKeys ?? []) {
        expect(names.has(fk.column)).toBe(true);
        const parent = tables.get(fk.references.table);
        expect(parent?.columns.some((x) => x.name === fk.references.column)).toBe(true);
      }
    }
  });
  test("load order puts parents before children", () => {
    expect(CONTRACTS.map((c) => c.table)).toEqual([
      "customers",
      "products",
      "transactions",
      "complaints",
      "call_center_interactions",
    ]);
  });
});
