import { join } from "node:path";
import { ROOT } from "../pipeline/config";
import { loadServerConfig } from "../server/config";
import { sha256Hex } from "../server/hash";
import { createGeminiLlm } from "../server/llm/gemini";
import { SpendLedger } from "../server/llm/ledger";
import { RunBudget, meteredLlm } from "../server/llm/metered";
import { loadFrozenTestSet, readUtterancesCsv, toJsonl } from "./dataset";
import { PARAPHRASE_PROMPT_VERSION, generateTrainingSet } from "./paraphrase";

/**
 * `bun run ml:generate`: expands the hand-written seeds with Gemini paraphrases into ml/data/router-train.jsonl.
 * Spend is capped by the project ledger and by ML_RUN_LIMIT_USD (default 0.5) for this run.
 */
const env = { ...process.env, JWT_SECRET: process.env.JWT_SECRET ?? "x".repeat(32) };
const cfg = loadServerConfig(env);
if (!cfg.geminiApiKey) throw new Error("GEMINI_API_KEY is required to generate paraphrases");
const perFamily = Number(process.env.ML_PER_FAMILY ?? 12);
const budget = new RunBudget(new SpendLedger(cfg.spendLedgerPath, cfg.llmTotalCapUsd), Number(process.env.ML_RUN_LIMIT_USD ?? 0.5), "ml:generate");
const llm = meteredLlm(createGeminiLlm(cfg.geminiApiKey, cfg.geminiModel), budget, "paraphrase");

const seedsText = await Bun.file(join(ROOT, "ml/data/router-seeds.csv")).text();
const seeds = readUtterancesCsv(seedsText, "human");
const test = await loadFrozenTestSet(join(ROOT, "ml/data/router-test.csv"), join(ROOT, "ml/data/router-test.sha256"));
console.log(`seeds ${seeds.length} · families ${new Set(seeds.map((s) => s.family)).size} · ${perFamily} paraphrases per family`);

const report = await generateTrainingSet(seeds, llm, { perFamily, exclude: test.map((t) => t.text), concurrency: 4 });
await Bun.write(join(ROOT, "ml/data/router-train.jsonl"), toJsonl(report.rows));
const meta = {
  createdAt: new Date().toISOString(),
  model: cfg.geminiModel,
  promptVersion: PARAPHRASE_PROMPT_VERSION,
  seedsHash: sha256Hex(seedsText),
  perFamily,
  rows: report.rows.length,
  families: report.families,
  failedFamilies: report.failedFamilies,
  droppedDuplicates: report.droppedDuplicates,
  droppedExcluded: report.droppedExcluded,
  spentUsd: budget.spent(),
};
await Bun.write(join(ROOT, "ml/data/router-train.meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
console.log(meta);
