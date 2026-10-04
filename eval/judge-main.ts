import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ROOT } from "../pipeline/config";
import { loadServerConfig } from "../server/config";
import { openServing } from "../server/db/serving";
import { createGeminiLlm } from "../server/llm/gemini";
import { SpendLedger } from "../server/llm/ledger";
import { RunBudget, SpendCapError, meteredLlm } from "../server/llm/metered";
import { type Reference, renderJudgeReport } from "./agreement";
import { deterministicLabel } from "./deterministic-judge";
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
    const read = (name: string) =>
      (existsSync(join(DIR, name)) ? JSON.parse(readFileSync(join(DIR, name), "utf8")) : {}) as Record<string, Label>;
    // Deterministic reference over every judged item: the customer comes from the run the items were drawn from.
    const run = JSON.parse(readFileSync(join(ROOT, `data/eval/runs/${runId}.json`), "utf8")) as EvalResult;
    const customerOf = new Map(Object.values(run.systems).flat().map((r) => [r!.s.id, r!.s.customerId]));
    const serving = openServing(join(ROOT, "data/serving.sqlite"));
    const deterministic = Object.fromEntries(items.map((i) => [i.key, deterministicLabel(i, customerOf.get(i.scenarioId)!, serving)]));
    const references: Reference[] = [
      {
        name: "deterministic checks",
        description: `Every judged item (the judge covered ${Object.values(verdicts).filter(Boolean).length} of ${items.length} before its spend limit), labeled by the system's own response gate with the customer's full records: grounded = no unsupported amount or unknown id; language = detected language matches the session; tone = no improvised commitment outside policy templates and no credential request (eval/deterministic-judge.ts). The problem statement allows validating a judge "against human or deterministic judgments".`,
        labels: deterministic,
      },
      {
        name: "a second AI rater (not human)",
        description: "The 50-item sample labeled by Claude (Anthropic), the same coding assistant that built the system, against the same rubric and evidence, without seeing the second-pass verdicts or which system answered (it had seen the discarded first pass in aggregate). This is model-to-model agreement, not independent, and NOT a human validation.",
        labels: read("labels-ai.json"),
      },
      {
        name: "human labels",
        description: "The 50-item blind sample labeled by a team member, without seeing the judge's verdicts or which system answered.",
        labels: read("labels.json"),
      },
    ];
    mkdirSync(join(ROOT, "reports"), { recursive: true });
    writeFileSync(join(ROOT, "reports/judge.md"), renderJudgeReport({
        runId,
        items,
        verdicts,
        references,
        notes: [
          "No human validation: spec 7 asks for human labels (about 50, ideally 100–200 for safety) with κ ≥ 0.6. That requirement is not met. The deterministic κ is below 0.6, and the AI rater's 0.65 rests on 2 negative labels in n = 33.",
          "The figures in these notes describe run eval-2026-10-04T03-00-40-141Z and judge v2026-10-04.2; recompute them after a rerun.",
          "Prevalence: almost every reply passes, so Cohen's κ is unstable (the kappa paradox): against the deterministic checks the judge agrees on 90.8% of items yet κ is low because the few negatives differ.",
          "Where they differ: the deterministic gate checks only amounts, ids, language and commitment wording; it flags ids the customer typed and translated statuses (\"Aprobada\", \"Aprovada\") that the judge accepts, and it cannot see invented non-numeric facts (branch hours, a merchant category) that the judge rejects. Case references (D-…, H-…) are removed before the check, so an invented reference is not caught.",
          "Evidence revision: a first judge pass (judge v2026-10-04.1) gave the judge only the transactions cited by id and no masked numbers, limits, times or channels; it marked 47% of proposed replies ungrounded for facts that were in the database. The evidence and rubric were corrected (v2026-10-04.2) before the results above; the first pass is kept in data/ and not reported as the result.",
          "Budget: the second pass stopped at its spend limit after 119 of 150 items (100 proposed, 19 baseline); 33 of the 50 sampled items were judged.",
        ],
      }));
    console.log("report → reports/judge.md");
  }
}
