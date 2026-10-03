import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type Utterance, loadFrozenTestSet, readUtterancesCsv } from "../../ml/dataset";
import { type RouterResult, runExperiment, selectRouter } from "../../ml/experiment";
import { renderRouterReport } from "../../ml/report";
import { dropNearTest, splitByFamily, stratifiedSample } from "../../ml/split";
import { createKeywordRouter } from "../../server/router/keyword";
import type { Router } from "../../server/router/types";
import { fakeEmbedder } from "./fakes";

const ROOT = join(import.meta.dir, "../..");
const seeds = async () => readUtterancesCsv(await Bun.file(join(ROOT, "ml/data/router-seeds.csv")).text(), "human");
const testSet = () => loadFrozenTestSet(join(ROOT, "ml/data/router-test.csv"), join(ROOT, "ml/data/router-test.sha256"));

describe("splits", () => {
  const row = (id: string, family: string, label: Utterance["label"] = "greeting"): Utterance => ({
    id,
    lang: "es",
    variant: "MX",
    label,
    text: id,
    family,
    source: "human",
  });

  test("no family is on both sides and every multi-family group contributes to dev", () => {
    const rows = ["a", "b", "c", "d", "e"].flatMap((f) => [row(`${f}1`, f), row(`${f}2`, f)]);
    const s = splitByFamily(rows, 0.2, 1);
    const trainFams = new Set(s.train.map((r) => r.family));
    expect(s.dev.length).toBeGreaterThan(0);
    expect(s.dev.every((r) => !trainFams.has(r.family))).toBe(true);
    expect(splitByFamily(rows, 0.2, 1).devFamilies).toEqual(s.devFamilies);
  });

  test("near-duplicates of test rows are dropped from training", () => {
    const train = [row("x", "f"), row("y", "f")];
    const vecs = new Map([
      ["x", [1, 0]],
      ["y", [0, 1]],
    ]);
    const r = dropNearTest(train, vecs, [[0.999, 0.0447]], 0.95);
    expect(r.dropped.map((u) => u.id)).toEqual(["x"]);
    expect(r.kept.map((u) => u.id)).toEqual(["y"]);
  });

  test("stratified sample caps each (label, language) group", () => {
    const rows = [...Array.from({ length: 5 }, (_, i) => row(`g${i}`, "f")), ...Array.from({ length: 5 }, (_, i) => row(`h${i}`, "h", "check_balance"))];
    expect(stratifiedSample(rows, 2, 3).length).toBe(4);
  });
});

describe("selection rule", () => {
  const result = (name: string, macroF1: number, oos: number, usd: number) =>
    ({ name, test: { macroF1 }, outOfScopeRecall: oos, usdPerClassification: usd }) as unknown as RouterResult;

  test("picks the best deployable router above the safety floor; zero-shot is never selected", () => {
    const s = selectRouter([result("keyword", 0.6, 0.9, 0), result("embed-lr", 0.85, 0.9, 1e-6), result("gemini-zeroshot", 0.95, 0.95, 1e-4)]);
    expect(s.router).toBe("embed-lr");
    expect(s.rationale).toContain("not deployable");
  });

  test("the safety floor beats macro-F1, and a near tie goes to the cheaper router", () => {
    expect(selectRouter([result("keyword", 0.6, 0.9, 0), result("embed-lr", 0.85, 0.5, 1e-6)]).router).toBe("keyword");
    expect(selectRouter([result("keyword", 0.845, 0.9, 0), result("embed-lr", 0.85, 0.9, 1e-6)]).router).toBe("keyword");
  });
});

describe("runExperiment (fake embedder, no network)", () => {
  test("trains on seeds, evaluates every router on the frozen test set and is deterministic", async () => {
    const train = await seeds();
    const test = await testSet();
    const zeroShot: Router = { name: "fake-zs", route: async () => ({ label: "out_of_scope", confidence: 0.4, router: "fake-zs" }) };
    const deps = {
      test,
      train,
      embedder: fakeEmbedder(96),
      keyword: createKeywordRouter(),
      zeroShot,
      seed: 7,
      zeroShotDevPerGroup: 2,
      latencySample: 3,
      l2Grid: [1e-3],
      epochs: 60,
    };
    const r = await runExperiment(deps);
    expect(r.routers.map((x) => x.name)).toEqual(["keyword", "embed-lr", "gemini-zeroshot"]);
    for (const x of r.routers) {
      expect(x.test.n).toBe(test.length);
      expect(x.test.macroF1).toBeGreaterThanOrEqual(0);
      expect(x.test.macroF1).toBeLessThanOrEqual(1);
      expect(x.macroF1CI[0]).toBeLessThanOrEqual(x.macroF1CI[1]);
      expect(Object.keys(x.perLanguageMacroF1)).toEqual(["es", "pt"]);
    }
    expect(r.routers.find((x) => x.name === "embed-lr")!.test.macroF1).toBeGreaterThan(0.3);
    expect(r.data.devRows).toBeGreaterThan(0);
    expect(r.data.trainRows + r.data.devRows + r.data.droppedNearTest).toBe(train.length);
    expect(["keyword", "embed-lr"]).toContain(r.selected.router);
    expect(r.model.labels).toHaveLength(7);

    r.runId = "router-test";
    const md = renderRouterReport(r, { model: "gemini-embedding-001", trainSource: "seeds", spentUsd: 0 });
    expect(md).toContain("| keyword");
    expect(md).toContain("**(selected)**");
    expect(md).toContain("## Confusion matrix");
    expect(md).toContain("cosine > 0.95");

    const again = await runExperiment({ ...deps, embedder: fakeEmbedder(96) });
    expect(again.routers.map((x) => x.test.macroF1)).toEqual(r.routers.map((x) => x.test.macroF1));
  }, 60_000);
});
