import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type Utterance, loadFrozenTestSet, readUtterancesCsv } from "../../ml/dataset";
import { EMBED_LR_VERSION, type RouterResult, runExperiment, selectRouter } from "../../ml/experiment";
import { renderRouterReport } from "../../ml/report";
import { dropNearTest, splitByFamily, stratifiedSample } from "../../ml/split";
import type { Embedder } from "../../server/llm/embedder";
import { SpendCapError } from "../../server/llm/metered";
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

  test("ES/PT translation pairs (same family id minus the language prefix) never straddle train/dev", () => {
    const pairRow = (lang: "es" | "pt", n: number): Utterance => ({
      id: `${lang}-${n}`,
      lang,
      variant: lang === "es" ? "MX" : "BR",
      label: "dispute_charge",
      text: `${lang}-text-${n}`,
      family: `${lang}-dsp-${n}`,
      source: "human",
    });
    for (const seed of [1, 2, 3, 4, 5]) {
      const rows = Array.from({ length: 10 }, (_, i) => i + 1).flatMap((n) => [pairRow("es", n), pairRow("pt", n)]);
      const s = splitByFamily(rows, 0.3, seed);
      for (let n = 1; n <= 10; n++) {
        const esInDev = s.dev.some((r) => r.id === `es-${n}`);
        const ptInDev = s.dev.some((r) => r.id === `pt-${n}`);
        expect(esInDev).toBe(ptInDev);
      }
      expect(s.dev.length).toBeGreaterThan(0);
    }
  });
});

describe("selection rule", () => {
  const result = (name: string, macroF1: number, oosSafeRate: number, usd: number) =>
    ({ name, test: { macroF1 }, outOfScopeRecall: oosSafeRate, outOfScopeSafeRate: oosSafeRate, usdPerClassification: usd }) as unknown as RouterResult;

  test("picks the best deployable router above the safety floor; zero-shot is never selected", () => {
    const s = selectRouter([result("keyword", 0.6, 0.9, 0), result("embed-lr", 0.85, 0.9, 1e-6), result("gemini-zeroshot", 0.95, 0.95, 1e-4)]);
    expect(s.router).toBe("embed-lr");
    expect(s.rationale).toContain("not deployable");
  });

  test("the safety floor beats macro-F1, and a near tie goes to the cheaper router", () => {
    expect(selectRouter([result("keyword", 0.6, 0.9, 0), result("embed-lr", 0.85, 0.5, 1e-6)]).router).toBe("keyword");
    expect(selectRouter([result("keyword", 0.845, 0.9, 0), result("embed-lr", 0.85, 0.9, 1e-6)]).router).toBe("keyword");
  });

  test("the floor is outOfScopeSafeRate, not the plain outOfScopeRecall", () => {
    const withRates = (name: string, macroF1: number, outOfScopeRecall: number, outOfScopeSafeRate: number, usd: number) =>
      ({ name, test: { macroF1 }, outOfScopeRecall, outOfScopeSafeRate, usdPerClassification: usd }) as unknown as RouterResult;
    // embed-lr has a low plain recall (abstentions aren't hits) but a high safe rate (those abstentions clarify
    // instead of misrouting); it should still clear the floor and win on macro-F1.
    const s = selectRouter([withRates("keyword", 0.6, 0.9, 0.5, 0), withRates("embed-lr", 0.85, 0.1, 0.95, 1e-6)]);
    expect(s.router).toBe("embed-lr");
    expect(s.rationale).toContain("safe rate 0.950");
  });

  test("a keyword-like router that abstains on everything gets out_of_scope recall 0 under the new scoring", async () => {
    const abstainer: Router = { name: "fake-keyword", route: async () => ({ label: "out_of_scope", confidence: 0, router: "fake-keyword" }) };
    const deps = {
      test: await testSet(),
      train: await seeds(),
      embedder: fakeEmbedder(32),
      keyword: abstainer,
      zeroShot: null,
      seed: 7,
      zeroShotDevPerGroup: 2,
      latencySample: 1,
      l2Grid: [1e-3],
      epochs: 10,
    };
    const r = await runExperiment(deps);
    const kw = r.routers.find((x) => x.name === "keyword")!;
    // Before the fix, an abstention labeled out_of_scope at confidence 0 was scored as a correct out_of_scope
    // prediction, inflating recall to 1. It is now "__abstain__" for scoring, so recall on the real class is 0.
    expect(kw.outOfScopeRecall).toBe(0);
    expect(kw.outOfScopeSafeRate).toBeGreaterThan(0);
  }, 30_000);
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

    expect(r.config).toEqual({
      seed: 7,
      devShare: 0.2,
      cosineCutoff: 0.95,
      l2Grid: [1e-3],
      epochs: 60,
      zeroShotDevPerGroup: 2,
      latencySample: 3,
      embedLrVersion: EMBED_LR_VERSION,
    });
    expect(r.routers.find((x) => x.name === "keyword")!.version).toBe("keyword-v1");
    expect(r.routers.find((x) => x.name === "embed-lr")!.version).toBe(`embed-lr@${EMBED_LR_VERSION}`);
    expect(r.routers.find((x) => x.name === "gemini-zeroshot")!.version).toBe("fake-zs");
    expect(r.zeroShotSkipped).toBeUndefined();
    expect(r.zeroShotDevSampleSize).toBeGreaterThan(0);
    for (const x of r.routers) expect(x.failures).toBeGreaterThanOrEqual(0);

    r.runId = "router-test";
    const md = renderRouterReport(r, { model: "gemini-embedding-001", trainSource: "seeds", spentUsd: 0 });
    expect(md).toContain("| keyword");
    expect(md).toContain("**(selected)**");
    expect(md).toContain("## Confusion matrix");
    expect(md).toContain("cosine > 0.95");
    expect(md).toContain("the selection rule used test metrics (rule fixed before evaluation)");
    expect(md).toContain(`stratified dev sample of ${r.zeroShotDevSampleSize} rows`);

    const again = await runExperiment({ ...deps, embedder: fakeEmbedder(96) });
    expect(again.routers.map((x) => x.test.macroF1)).toEqual(r.routers.map((x) => x.test.macroF1));
  }, 60_000);
});

describe("runExperiment resilience (fake providers)", () => {
  const baseDeps = async () => ({
    test: await testSet(),
    train: await seeds(),
    keyword: createKeywordRouter(),
    seed: 7,
    zeroShotDevPerGroup: 2,
    latencySample: 3,
    l2Grid: [1e-3],
    epochs: 60,
  });

  test("a SpendCapError from zero-shot is caught: keyword and embed-lr results, model and report still come out", async () => {
    const deps = await baseDeps();
    const zeroShot: Router = {
      name: "fake-zs",
      route: async () => {
        throw new SpendCapError("run limit of $0.5 reached");
      },
    };
    const r = await runExperiment({ ...deps, embedder: fakeEmbedder(96), zeroShot });
    expect(r.routers.map((x) => x.name)).toEqual(["keyword", "embed-lr"]);
    expect(r.zeroShotSkipped).toBeDefined();
    expect(r.zeroShotSkipped).toContain("BUD_TOTAL");
    expect(r.zeroShotDevSampleSize).toBeNull();
    expect(r.model.labels).toHaveLength(7);

    r.runId = "router-test-skipped";
    const md = renderRouterReport(r, { model: "gemini-embedding-001", trainSource: "seeds", spentUsd: 0 });
    expect(md).toContain("gemini-zeroshot was skipped");
    expect(md).toContain("BUD_TOTAL");
  }, 60_000);

  test("a non-SpendCapError from zero-shot still propagates", async () => {
    const deps = await baseDeps();
    const zeroShot: Router = {
      name: "fake-zs",
      route: async () => {
        throw new Error("boom");
      },
    };
    await expect(runExperiment({ ...deps, embedder: fakeEmbedder(96), zeroShot })).rejects.toThrow("boom");
  }, 60_000);

  test("an embedder that fails mid-run still keeps the first chunk's vectors via onEmbedded", async () => {
    const deps = await baseDeps();
    const dim = 8;
    let calls = 0;
    const vec = () => new Array(dim).fill(1 / Math.sqrt(dim));
    const failingEmbedder: Embedder = {
      model: "fake-chunked",
      dim,
      async embed(texts) {
        calls++;
        if (calls === 2) throw new Error("simulated network failure");
        return { vectors: texts.map(vec), inputTokens: texts.length };
      },
    };
    const snapshots: number[] = [];
    await expect(
      runExperiment({
        ...deps,
        embedder: failingEmbedder,
        zeroShot: null,
        onEmbedded: (cache) => {
          snapshots.push(cache.size);
        },
      }),
    ).rejects.toThrow("simulated network failure");
    expect(snapshots).toEqual([100]);
  }, 60_000);
});
