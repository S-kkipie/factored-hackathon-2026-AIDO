import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ROOT } from "../pipeline/config";
import { loadServerConfig } from "../server/config";
import { openServing } from "../server/db/serving";
import { createGeminiLlm } from "../server/llm/gemini";
import { SpendLedger } from "../server/llm/ledger";
import { RunBudget, SpendCapError, meteredLlm } from "../server/llm/metered";
import { renderJudgeReport } from "./agreement";
import { type JudgeItem, type Verdict, judge, judgeSet, labelSample } from "./judge";
import type { Label } from "./label";
import type { EvalResult } from "./main";

const DIR = join(ROOT, "data/eval/judge");

if (import.meta.main) {
  const { values } = parseArgs({
    options: { run: { type: "string" }, sample: { type: "boolean" }, judge: { type: "boolean" }, "limit-usd": { type: "string" }, report: { type: "boolean" } },
  });
  mkdirSync(DIR, { recursive: true });
  if (values.sample) {
    if (!values.run) throw new Error("--run <data/eval/runs/<id>.json> is required with --sample");
    const result = JSON.parse(readFileSync(values.run, "utf8")) as EvalResult;
    const items = judgeSet(result, openServing(join(ROOT, "data/serving.sqlite")));
    writeFileSync(join(DIR, "items.json"), JSON.stringify({ runId: result.runId, items }, null, 1));
    writeFileSync(join(DIR, "sample.json"), JSON.stringify(labelSample(items).map((i) => i.key), null, 1));
    console.log(`judge set ${items.length} items; label sample 50 → ${DIR}`);
  }
  if (values.judge) {
    if (!values["limit-usd"]) throw new Error("--limit-usd is required with --judge");
    const cfg = loadServerConfig({ ...process.env, JWT_SECRET: process.env.JWT_SECRET ?? "judge-secret-judge-secret-judge-secret" });
    if (!cfg.geminiApiKey) throw new Error("GEMINI_API_KEY is required for --judge");
    const { items } = JSON.parse(readFileSync(join(DIR, "items.json"), "utf8")) as { items: JudgeItem[] };
    const path = join(DIR, "verdicts.json");
    const verdicts = (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}) as Record<string, Verdict | null>;
    const budget = new RunBudget(new SpendLedger(cfg.spendLedgerPath, cfg.llmTotalCapUsd), Number(values["limit-usd"]), "eval-judge");
    const llm = meteredLlm(createGeminiLlm(cfg.geminiApiKey, cfg.geminiModel), budget, "eval-judge");
    for (const item of items) {
      if (item.key in verdicts && verdicts[item.key] !== null) continue;
      try {
        verdicts[item.key] = await judge(llm, item.evidence);
      } catch (e) {
        if (e instanceof SpendCapError) break;
        verdicts[item.key] = null;
      }
      writeFileSync(path, JSON.stringify(verdicts, null, 1));
    }
    console.log(`judged ${Object.values(verdicts).filter(Boolean).length}/${items.length} · spend $${budget.spent().toFixed(4)}`);
  }
  if (values.report) {
    const { runId, items } = JSON.parse(readFileSync(join(DIR, "items.json"), "utf8")) as { runId: string; items: JudgeItem[] };
    const verdictsPath = join(DIR, "verdicts.json");
    const verdicts = (existsSync(verdictsPath) ? JSON.parse(readFileSync(verdictsPath, "utf8")) : {}) as Record<string, Verdict | null>;
    const labelsPath = join(DIR, "labels.json");
    const labels = (existsSync(labelsPath) ? JSON.parse(readFileSync(labelsPath, "utf8")) : {}) as Record<string, Label>;
    mkdirSync(join(ROOT, "reports"), { recursive: true });
    writeFileSync(join(ROOT, "reports/judge.md"), renderJudgeReport({ runId, items, verdicts, labels }));
    console.log("report → reports/judge.md");
  }
}
