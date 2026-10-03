import { describe, expect, test } from "bun:test";
import { openDuck } from "../../pipeline/duck";
import { mdTable } from "../../pipeline/markdown";
import { ident, lit } from "../../pipeline/sql";

describe("sql quoting", () => {
  test("lit escapes single quotes", () => {
    expect(lit("O'Brien")).toBe("'O''Brien'");
  });
  test("ident escapes double quotes", () => {
    expect(ident('a"b')).toBe('"a""b"');
  });
});

describe("openDuck", () => {
  test("runs statements and returns JSON rows", async () => {
    const duck = await openDuck(":memory:");
    await duck.run("create table t (id varchar, n integer); insert into t values ('a', 1), ('b', 2)");
    expect(await duck.all("select id, n from t order by id")).toEqual([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ]);
    expect(await duck.one<{ total: number }>("select sum(n)::integer as total from t")).toEqual({ total: 3 });
    duck.close();
  });
  test("one() throws when the query returns no rows", async () => {
    const duck = await openDuck(":memory:");
    await expect(duck.one("select 1 where false")).rejects.toThrow("no rows");
    duck.close();
  });
});

describe("mdTable", () => {
  test("renders a markdown table", () => {
    expect(mdTable([{ a: 1, b: null }])).toBe("| a | b |\n| --- | --- |\n| 1 |  |\n");
  });
  test("renders a placeholder for empty input", () => {
    expect(mdTable([])).toBe("_none_\n");
  });
});
