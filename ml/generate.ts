import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../pipeline/config";
import { loadServerConfig } from "../server/config";
import { sha256Hex } from "../server/hash";
import { createGeminiLlm } from "../server/llm/gemini";
import { SpendLedger } from "../server/llm/ledger";
import { RunBudget, meteredLlm } from "../server/llm/metered";
import { loadFrozenTestSet, readJsonl, readUtterancesCsv, toJsonl } from "./dataset";
import { PARAPHRASE_PROMPT_VERSION, generateTrainingSet } from "./paraphrase";

/**
 * `bun run ml:generate`: expands the hand-written seeds with Gemini paraphrases into ml/data/router-train.jsonl.
 * Spend is capped by the project ledger and by ML_RUN_LIMIT_USD (default 0.5) for this run. A per-family failure
 * (including the spend cap) never loses the other families' paid work: the output and meta are always written,
 * with failures and their reasons recorded. Paraphrases already generated for this prompt version and seed file
 * are cached in data/ml-cache/ (git-ignored) and are not requested again on a re-run.
 */
const env = { ...process.env, JWT_SECRET: process.env.JWT_SECRET ?? "x".repeat(32) };
const cfg = loadServerConfig(env);
if (!cfg.geminiApiKey) throw new Error("GEMINI_API_KEY is required to generate paraphrases");

const perFamilyRaw = process.env.ML_PER_FAMILY ?? "12";
const perFamily = Number(perFamilyRaw);
if (!Number.isInteger(perFamily) || perFamily < 1 || perFamily > 30) {
  throw new Error(`ML_PER_FAMILY must be an integer between 1 and 30, got '${perFamilyRaw}'`);
}

const budget = new RunBudget(new SpendLedger(cfg.spendLedgerPath, cfg.llmTotalCapUsd), Number(process.env.ML_RUN_LIMIT_USD ?? 0.5), "ml:generate");
const llm = meteredLlm(createGeminiLlm(cfg.geminiApiKey, cfg.geminiModel), budget, "paraphrase");

const seedsText = await Bun.file(join(ROOT, "ml/data/router-seeds.csv")).text();
const seeds = readUtterancesCsv(seedsText, "human");
const test = await loadFrozenTestSet(join(ROOT, "ml/data/router-test.csv"), join(ROOT, "ml/data/router-test.sha256"));
console.log(`seeds ${seeds.length} · families ${new Set(seeds.map((s) => s.family)).size} · ${perFamily} paraphrases per family`);

const seedsHash = sha256Hex(seedsText);
const cacheDir = join(ROOT, "data/ml-cache");
mkdirSync(cacheDir, { recursive: true });
const cachePath = join(cacheDir, `paraphrases-${PARAPHRASE_PROMPT_VERSION}-${seedsHash.slice(0, 12)}.jsonl`);
const cacheFile = Bun.file(cachePath);
const cacheMap = new Map<string, string[]>(
  (await cacheFile.exists()) ? readJsonl<[string, string[]]>(await cacheFile.text()) : [],
);
const cache = {
  get: (family: string) => cacheMap.get(family),
  put: (family: string, paraphrases: string[]) => {
    cacheMap.set(family, paraphrases);
    appendFileSync(cachePath, `${JSON.stringify([family, paraphrases])}\n`);
  },
};

const report = await generateTrainingSet(seeds, llm, { perFamily, exclude: test.map((t) => t.text), concurrency: 4, cache });
await Bun.write(join(ROOT, "ml/data/router-train.jsonl"), toJsonl(report.rows));
const meta = {
  createdAt: new Date().toISOString(),
  model: cfg.geminiModel,
  promptVersion: PARAPHRASE_PROMPT_VERSION,
  seedsHash,
  perFamily,
  rows: report.rows.length,
  families: report.families,
  failedFamilies: report.failedFamilies,
  failureReasons: report.failureReasons,
  stoppedBySpendCap: report.stoppedBySpendCap,
  cachedFamilies: report.cachedFamilies,
  droppedDuplicates: report.droppedDuplicates,
  droppedExcluded: report.droppedExcluded,
  spentUsd: budget.spent(),
};
await Bun.write(join(ROOT, "ml/data/router-train.meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
console.log(meta);
