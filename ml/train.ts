import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../pipeline/config";
import { loadServerConfig } from "../server/config";
import { createGeminiEmbedder } from "../server/llm/embedder";
import { createGeminiLlm } from "../server/llm/gemini";
import { SpendLedger } from "../server/llm/ledger";
import { RunBudget, meteredEmbedder, meteredLlm } from "../server/llm/metered";
import { createGeminiRouter } from "../server/router/gemini";
import { createKeywordRouter } from "../server/router/keyword";
import { type Utterance, loadFrozenTestSet, readJsonl } from "./dataset";
import { EMBED_LR_VERSION, runExperiment } from "./experiment";
import { renderRouterReport } from "./report";

/**
 * `bun run train`: trains the embeddings + logistic-regression router and compares it with the keyword baseline
 * and Gemini zero-shot on the frozen test set. Writes experiments/<run_id>.json, reports/router.md and the model
 * files the server loads. Spend is capped by the project ledger and ML_RUN_LIMIT_USD (default 0.5).
 * Embeddings are cached in data/ml-cache/ (git-ignored) so re-runs cost nothing for unchanged texts.
 */
const env = { ...process.env, JWT_SECRET: process.env.JWT_SECRET ?? "x".repeat(32) };
const cfg = loadServerConfig(env);
if (!cfg.geminiApiKey) throw new Error("GEMINI_API_KEY is required to train the router");
const budget = new RunBudget(new SpendLedger(cfg.spendLedgerPath, cfg.llmTotalCapUsd), Number(process.env.ML_RUN_LIMIT_USD ?? 0.5), "train");
const embedder = meteredEmbedder(createGeminiEmbedder(cfg.geminiApiKey), budget, "router-embed");
const zeroShot = process.env.ML_SKIP_ZERO_SHOT === "1" ? null : createGeminiRouter(meteredLlm(createGeminiLlm(cfg.geminiApiKey, cfg.geminiModel), budget, "router-zeroshot"));

const cacheDir = join(ROOT, "data/ml-cache");
mkdirSync(cacheDir, { recursive: true });
const cachePath = join(cacheDir, `embeddings-${embedder.model}-${embedder.dim}.jsonl`);
const cacheFile = Bun.file(cachePath);
const cache = new Map<string, number[]>(
  (await cacheFile.exists()) ? readJsonl<[string, number[]]>(await cacheFile.text()) : [],
);

const test = await loadFrozenTestSet(join(ROOT, "ml/data/router-test.csv"), join(ROOT, "ml/data/router-test.sha256"));
const train = readJsonl<Utterance>(await Bun.file(join(ROOT, "ml/data/router-train.jsonl")).text());

const result = await runExperiment({
  test,
  train,
  embedder,
  keyword: createKeywordRouter(),
  zeroShot,
  cache,
  seed: 20261003,
  zeroShotDevPerGroup: 5,
  latencySample: 20,
  spent: () => budget.spent(),
});
result.runId = `router-${new Date().toISOString().replace(/[:.]/g, "-")}`;

await Bun.write(cachePath, [...cache.entries()].map((e) => JSON.stringify(e)).join("\n") + "\n");
mkdirSync(join(ROOT, "experiments"), { recursive: true });
mkdirSync(join(ROOT, "ml/models"), { recursive: true });
const { model, ...summary } = result;
await Bun.write(join(ROOT, "experiments", `${result.runId}.json`), `${JSON.stringify({ ...summary, spentUsd: budget.spent(), embedModel: embedder.model }, null, 2)}\n`);
await Bun.write(join(ROOT, "ml/models/router-embed-lr.json"), `${JSON.stringify({ version: EMBED_LR_VERSION, runId: result.runId, ...model })}\n`);
await Bun.write(
  join(ROOT, "ml/models/router-selection.json"),
  `${JSON.stringify({ router: result.selected.router, runId: result.runId, rationale: result.selected.rationale }, null, 2)}\n`,
);
await Bun.write(
  join(ROOT, "reports/router.md"),
  renderRouterReport(result, { model: embedder.model, trainSource: "hand-written seeds + Gemini paraphrases", spentUsd: budget.spent() }),
);
console.log(`run ${result.runId} · selected ${result.selected.router} · spent $${budget.spent().toFixed(4)}`);
for (const r of result.routers) console.log(`  ${r.name}: macro-F1 ${r.test.macroF1.toFixed(3)} · OOS recall ${r.outOfScopeRecall.toFixed(3)}`);
