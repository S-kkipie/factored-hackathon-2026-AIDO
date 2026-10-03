import { sha256Hex } from "../server/hash";
import type { Embedder } from "../server/llm/embedder";
import { createEmbeddingRouter } from "../server/router/embedding";
import { type LogRegModel, predictProba } from "../server/router/linear";
import type { Router } from "../server/router/types";
import { ROUTER_LABELS, type Utterance } from "./dataset";
import { fitTemperature, train } from "./logreg";
import { type CoveragePoint, type Prediction, type Report, bootstrapCI, chooseThreshold, coverageCurve, evaluate } from "./metrics";
import { dropNearTest, splitByFamily, stratifiedSample } from "./split";

export const EMBED_LR_VERSION = "1";
/** Routers that fit the per-turn budget (≤ 3 chat calls) and can be deployed; see the selection rule below. */
export const DEPLOYABLE = ["keyword", "embed-lr"] as const;

export interface ExperimentDeps {
  test: Utterance[];
  train: Utterance[];
  embedder: Embedder;
  keyword: Router;
  /** Null skips the zero-shot comparison (no model available). */
  zeroShot: Router | null;
  /** Optional cache: text → unit vector. */
  cache?: Map<string, number[]>;
  seed: number;
  /** Zero-shot dev rows per (label, language) used to pick its threshold. */
  zeroShotDevPerGroup: number;
  /** Live embed-lr calls timed for latency (the batch path is not representative). */
  latencySample: number;
  l2Grid?: number[];
  epochs?: number;
  /** Total USD spent so far by this run (RunBudget.spent); used to price the zero-shot router. */
  spent?: () => number;
}

export interface RouterResult {
  name: string;
  threshold: number;
  test: Report;
  macroF1CI: [number, number];
  perLanguageMacroF1: Record<string, number>;
  outOfScopeRecall: number;
  /** At the dev-chosen threshold: share of test messages routed (rest clarify) and their misroute rate. */
  atThreshold: CoveragePoint;
  coverageCurve: CoveragePoint[];
  latencyMs: { p50: number; p95: number };
  usdPerClassification: number;
}

export interface ExperimentResult {
  runId: string;
  data: {
    testHash: string;
    trainHash: string;
    trainRows: number;
    devRows: number;
    droppedNearTest: number;
    devFamilies: string[];
  };
  embedLr: { l2: number; temperature: number; devMacroF1ByL2: Record<string, number> };
  routers: RouterResult[];
  selected: { router: (typeof DEPLOYABLE)[number]; rationale: string };
  model: LogRegModel;
}

const hashRows = (rows: readonly Utterance[]) =>
  sha256Hex(rows.map((r) => `${r.id}\t${r.label}\t${r.text}`).join("\n"));

const percentile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};

const argmaxPred = (m: LogRegModel, gold: Utterance, v: number[]): Prediction => {
  const p = predictProba(m, v);
  const k = p.indexOf(Math.max(...p));
  return { gold: gold.label, pred: m.labels[k]!, confidence: p[k]!, lang: gold.lang };
};

async function embedAll(deps: ExperimentDeps, texts: string[]): Promise<Map<string, number[]>> {
  const cache = deps.cache ?? new Map<string, number[]>();
  const missing = [...new Set(texts)].filter((t) => !cache.has(t));
  if (missing.length > 0) {
    const { vectors } = await deps.embedder.embed(missing);
    missing.forEach((t, i) => cache.set(t, vectors[i]!));
  }
  return cache;
}

async function routeAll(router: Router, rows: readonly Utterance[]) {
  const preds: Prediction[] = [];
  const ms: number[] = [];
  for (const r of rows) {
    const t0 = performance.now();
    const res = await router.route(r.text, r.lang);
    ms.push(performance.now() - t0);
    preds.push({ gold: r.label, pred: res.label, confidence: res.confidence, lang: r.lang });
  }
  return { preds, ms };
}

function summarize(name: string, preds: Prediction[], threshold: number, ms: number[], usd: number): RouterResult {
  const labels = [...ROUTER_LABELS];
  const test = evaluate(preds, labels);
  const perLanguageMacroF1 = Object.fromEntries(
    ["es", "pt"].map((lang) => [lang, evaluate(preds.filter((p) => p.lang === lang), labels).macroF1]),
  );
  const grid = Array.from({ length: 21 }, (_, i) => i / 20);
  return {
    name,
    threshold,
    test,
    macroF1CI: bootstrapCI(preds, (s) => evaluate(s, labels).macroF1, 1000, 42),
    perLanguageMacroF1,
    outOfScopeRecall: test.perClass.out_of_scope?.recall ?? 0,
    atThreshold: coverageCurve(preds, [threshold])[0]!,
    coverageCurve: coverageCurve(preds, grid),
    latencyMs: { p50: percentile(ms, 0.5), p95: percentile(ms, 0.95) },
    usdPerClassification: preds.length === 0 ? 0 : usd / preds.length,
  };
}

/**
 * Selection rule (spec 6), decided before looking at test results: among deployable routers, require
 * out_of_scope recall ≥ 0.8 (safety floor), then take the highest test macro-F1; a gap smaller than 0.01 goes to
 * the cheaper router. The zero-shot router is reported for comparison but not deployable: it would add a fourth
 * chat call to a turn whose budget is three (spec 3.2 rule 10).
 */
export function selectRouter(results: readonly RouterResult[]): ExperimentResult["selected"] {
  const pool = results.filter((r) => (DEPLOYABLE as readonly string[]).includes(r.name));
  const safe = pool.filter((r) => r.outOfScopeRecall >= 0.8);
  const ranked = (safe.length > 0 ? safe : pool).sort((a, b) => b.test.macroF1 - a.test.macroF1);
  let best = ranked[0];
  if (!best) throw new Error("no deployable router results");
  const cheaper = ranked.find((r) => r.usdPerClassification < best!.usdPerClassification);
  if (cheaper && best.test.macroF1 - cheaper.test.macroF1 < 0.01) best = cheaper;
  const zs = results.find((r) => r.name === "gemini-zeroshot");
  const rationale = [
    `${best.name} has test macro-F1 ${best.test.macroF1.toFixed(3)} and out_of_scope recall ${best.outOfScopeRecall.toFixed(3)}`,
    safe.length === 0 ? "no deployable router met the 0.8 out_of_scope recall floor, so the floor was waived" : "it meets the 0.8 out_of_scope recall floor",
    zs ? `gemini-zeroshot scored macro-F1 ${zs.test.macroF1.toFixed(3)} but is not deployable within the 3-calls-per-turn budget` : "",
  ]
    .filter(Boolean)
    .join("; ");
  return { router: best.name as (typeof DEPLOYABLE)[number], rationale };
}

export async function runExperiment(deps: ExperimentDeps): Promise<ExperimentResult> {
  const labels = [...ROUTER_LABELS];
  const vecs = await embedAll(deps, [...deps.train, ...deps.test].map((r) => r.text));
  const testVecs = deps.test.map((r) => vecs.get(r.text)!);

  const { kept, dropped } = dropNearTest(deps.train, vecs, testVecs, 0.95);
  const split = splitByFamily(kept, 0.2, deps.seed);
  const X = split.train.map((r) => vecs.get(r.text)!);
  const y = split.train.map((r) => r.label);
  const devX = split.dev.map((r) => vecs.get(r.text)!);

  // Model selection on dev only.
  const devMacroF1ByL2: Record<string, number> = {};
  let best: { l2: number; f1: number; model: LogRegModel } | null = null;
  for (const l2 of deps.l2Grid ?? [1e-4, 1e-3, 1e-2]) {
    const model = train(X, y, labels, { l2, epochs: deps.epochs ?? 300 });
    const f1 = evaluate(split.dev.map((r, i) => argmaxPred(model, r, devX[i]!)), labels).macroF1;
    devMacroF1ByL2[String(l2)] = f1;
    if (!best || f1 > best.f1) best = { l2, f1, model };
  }
  const model = best!.model;
  model.temperature = fitTemperature(model, devX, split.dev.map((r) => r.label));
  const embedThreshold = chooseThreshold(split.dev.map((r, i) => argmaxPred(model, r, devX[i]!)));

  const results: RouterResult[] = [];

  // Router 0: keyword baseline.
  const kwDev = await routeAll(deps.keyword, split.dev);
  const kwTest = await routeAll(deps.keyword, deps.test);
  results.push(summarize("keyword", kwTest.preds, chooseThreshold(kwDev.preds), kwTest.ms, 0));

  // Router 2: embeddings + LR. Test predictions from the batch embeddings; latency from live single calls.
  const embedPreds = deps.test.map((r, i) => argmaxPred(model, r, testVecs[i]!));
  const live = createEmbeddingRouter(deps.embedder, model, EMBED_LR_VERSION);
  const liveRun = await routeAll(live, deps.test.slice(0, deps.latencySample));
  const embedUsdPerCall = (Math.ceil(deps.test.reduce((n, r) => n + r.text.length, 0) / 4 / deps.test.length) * 0.15) / 1e6;
  results.push(summarize("embed-lr", embedPreds, embedThreshold, liveRun.ms, embedUsdPerCall * embedPreds.length));

  // Router 1: Gemini zero-shot (comparison only).
  if (deps.zeroShot) {
    const devSample = stratifiedSample(split.dev, deps.zeroShotDevPerGroup, deps.seed);
    const zsDev = await routeAll(deps.zeroShot, devSample);
    const before = deps.spent?.() ?? 0;
    const zsTest = await routeAll(deps.zeroShot, deps.test);
    const usd = (deps.spent?.() ?? 0) - before;
    results.push(summarize("gemini-zeroshot", zsTest.preds, chooseThreshold(zsDev.preds), zsTest.ms, usd));
  }

  return {
    runId: "",
    data: {
      testHash: hashRows(deps.test),
      trainHash: hashRows(deps.train),
      trainRows: split.train.length,
      devRows: split.dev.length,
      droppedNearTest: dropped.length,
      devFamilies: split.devFamilies,
    },
    embedLr: { l2: best!.l2, temperature: model.temperature, devMacroF1ByL2 },
    routers: results,
    selected: selectRouter(results),
    model,
  };
}
