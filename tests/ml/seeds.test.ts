import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadFrozenTestSet, normalizeForDedup, readUtterancesCsv } from "../../ml/dataset";

const ROOT = join(import.meta.dir, "../..");
const seeds = async () => readUtterancesCsv(await Bun.file(join(ROOT, "ml/data/router-seeds.csv")).text(), "human");
const testSet = () => loadFrozenTestSet(join(ROOT, "ml/data/router-test.csv"), join(ROOT, "ml/data/router-test.sha256"));

describe("hand-written seeds", () => {
  test("cover every label in both languages, in families of one label, with no test-set text", async () => {
    const s = await seeds();
    const t = await testSet();
    expect(s.length).toBeGreaterThanOrEqual(160);
    const byFamily = new Map<string, Set<string>>();
    for (const r of s) byFamily.set(r.family!, (byFamily.get(r.family!) ?? new Set()).add(`${r.label}|${r.lang}`));
    expect([...byFamily.values()].every((v) => v.size === 1)).toBe(true);
    const testTexts = new Set(t.map((r) => normalizeForDedup(r.text)));
    expect(s.filter((r) => testTexts.has(normalizeForDedup(r.text)))).toEqual([]);
  });
});
