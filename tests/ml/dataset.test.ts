import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ROUTER_LABELS,
  loadFrozenTestSet,
  normalizeForDedup,
  parseCsv,
  readJsonl,
  readUtterancesCsv,
  rng,
  shuffle,
  toJsonl,
} from "../../ml/dataset";
import { sha256Hex } from "../../server/hash";

const ROOT = join(import.meta.dir, "../..");

describe("CSV", () => {
  test("parses quotes, doubled quotes, embedded commas and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi"""\n')).toEqual([
      ["a", "b"],
      ["x, y", 'he said "hi"'],
    ]);
  });

  test("reads labeled rows and rejects unknown labels or languages", () => {
    const ok = readUtterancesCsv("id,lang,variant,label,text,family\nA1,es,MX,greeting,Hola,f1\n", "human");
    expect(ok).toEqual([{ id: "A1", lang: "es", variant: "MX", label: "greeting", text: "Hola", family: "f1", source: "human" }]);
    expect(() => readUtterancesCsv("id,lang,variant,label,text\nA1,es,MX,refund,x\n", "human")).toThrow("unknown label");
    expect(() => readUtterancesCsv("id,lang,variant,label,text\nA1,fr,FR,greeting,x\n", "human")).toThrow("unknown language");
  });

  test("JSONL round-trips", () => {
    expect(readJsonl(toJsonl([{ a: 1 }, { b: "x" }]))).toEqual([{ a: 1 }, { b: "x" }]);
  });
});

describe("frozen test set", () => {
  test("the committed test set matches its hash and covers every label in both languages", async () => {
    const rows = await loadFrozenTestSet(join(ROOT, "ml/data/router-test.csv"), join(ROOT, "ml/data/router-test.sha256"));
    expect(rows.length).toBeGreaterThanOrEqual(230);
    for (const label of ROUTER_LABELS) {
      for (const lang of ["es", "pt"] as const) {
        expect(rows.filter((r) => r.label === label && r.lang === lang).length).toBeGreaterThanOrEqual(15);
      }
    }
  });

  test("a modified file fails the hash check", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aido-frozen-"));
    writeFileSync(join(dir, "t.csv"), "id,lang,variant,label,text\nX,es,MX,greeting,Hola\n");
    writeFileSync(join(dir, "t.sha256"), `${sha256Hex("something else")}  t.csv\n`);
    await expect(loadFrozenTestSet(join(dir, "t.csv"), join(dir, "t.sha256"))).rejects.toThrow("frozen test set changed");
  });
});

describe("helpers", () => {
  test("normalizeForDedup ignores accents, case and punctuation", () => {
    expect(normalizeForDedup("¿Cuál es MI saldo?")).toBe(normalizeForDedup("cual es mi saldo"));
  });

  test("rng and shuffle are deterministic per seed", () => {
    expect(shuffle([1, 2, 3, 4, 5], rng(7))).toEqual(shuffle([1, 2, 3, 4, 5], rng(7)));
    expect(shuffle([1, 2, 3, 4, 5], rng(7)).sort()).toEqual([1, 2, 3, 4, 5]);
    const r = rng(1);
    for (let i = 0; i < 100; i++) {
      const x = r();
      expect(x >= 0 && x < 1).toBe(true);
    }
  });
});
