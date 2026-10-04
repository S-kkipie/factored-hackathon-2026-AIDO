import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { ROOT } from "../pipeline/config";
import { createTools } from "../server/tools";
import { PROMPT_VERSIONS } from "../server/llm/prompts";
import { RunBudget } from "../server/llm/metered";
import { POLICY } from "../server/policy/config";
import { createBaselineRunner, createGeminiFnClient } from "./baseline";
import { scenarioHash } from "./build";
import { type Grade, grade } from "./grade";
import type { Row } from "./metrics";
import { renderReport } from "./report";
import type { Scenario } from "./scenario";
import { createProposedRunner } from "./system";
import { createWorld } from "./world";

/**
 * Deterministic stratified subset for the (costlier) baseline: the first ceil(share × n) scenarios of every
 * family and language, so every category stays represented. share = 1 keeps everything.
 */
export function baselineSubset(scenarios: Scenario[], share: number): Scenario[] {
  if (!(share > 0 && share < 1)) return scenarios;
  const groups = new Map<string, Scenario[]>();
  for (const s of scenarios) groups.set(`${s.family}:${s.language}`, [...(groups.get(`${s.family}:${s.language}`) ?? []), s]);
  const keep = new Set([...groups.values()].flatMap((g) => g.slice(0, Math.ceil(g.length * share)).map((s) => s.id)));
  return scenarios.filter((s) => keep.has(s.id));
}

export interface EvalResult {
  runId: string;
  split: "dev" | "test";
  scenarioHash: string;
  createdAt: string;
  versions: { model: string; prompts: Record<string, string>; policy: string; router: string };
  systems: Partial<Record<"proposed" | "baseline", Row[]>>;
  repeats: { k: number; scenarioIds: string[]; grades: Grade[][] } | null;
  spendUsd: number;
  limitUsd: number;
  stoppedEarly: boolean;
  notes: string[];
  /** Shown as a bold line under the report title (e.g. to mark a frozen test run vs. a post-fix rerun). */
  label?: string;
}

/** Resolves a CLI-supplied path against the repo root, unless it is already absolute. */
const resolvePath = (p: string): string => (isAbsolute(p) ? p : join(ROOT, p));

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      split: { type: "string", default: "dev" },
      systems: { type: "string", default: "proposed,baseline" },
      "limit-usd": { type: "string" },
      families: { type: "string" },
      repeat: { type: "string", default: "0" },
      "repeat-n": { type: "string", default: "20" },
      "baseline-share": { type: "string", default: "1" },
      report: { type: "string" },
      max: { type: "string" },
      regrade: { type: "string" },
      label: { type: "string" },
    },
  });

  // Offline re-grade: load an already-run EvalResult, recompute every grade from the stored transcript with the
  // current grading logic, and re-render the report. No server, no model, no spend.
  if (values.regrade) {
    const runPath = resolvePath(values.regrade);
    const result = JSON.parse(readFileSync(runPath, "utf8")) as EvalResult;
    for (const sys of ["proposed", "baseline"] as const) {
      const rows = result.systems[sys];
      if (!rows) continue;
      for (const row of rows) row.g = grade(row.s, row.t);
    }
    // `repeats` stores only grades, not transcripts (spec): nothing to re-derive from, so they are kept as-is.
    if (values.label) result.label = values.label;
    if (!values.report) throw new Error("--report is required with --regrade");
    const reportPath = resolvePath(values.report);
    writeFileSync(reportPath, renderReport(result));
    console.log(`regraded ${runPath} -> ${reportPath}`);
    process.exit(0);
  }

  const split = values.split === "test" ? "test" : "dev";
  if (!values["limit-usd"]) throw new Error("--limit-usd is required (plan 5 total budget: USD 1.20)");
  const limitUsd = Number(values["limit-usd"]);
  const file = join(ROOT, `data/eval/${split}.json`);
  if (!existsSync(file)) throw new Error(`missing ${file}: run \`bun run eval:build\` first`);
  let scenarios = JSON.parse(readFileSync(file, "utf8")) as Scenario[];
  const hash = scenarioHash(scenarios);
  const frozen = JSON.parse(readFileSync(join(ROOT, "eval/frozen.json"), "utf8")) as Record<string, string>;
  if (split === "test" && frozen.test !== hash) throw new Error(`test set hash ${hash} differs from frozen ${frozen.test}`);
  if (values.families) scenarios = scenarios.filter((s) => values.families!.split(",").includes(s.family));
  if (values.max) scenarios = scenarios.slice(0, Number(values.max));

  const dir = mkdtempSync(join(tmpdir(), "aido-eval-"));
  const env = { ...process.env, OPS_PATH: join(dir, "ops.sqlite"), WEB_DIR: join(dir, "none"), JWT_SECRET: process.env.JWT_SECRET ?? "eval-secret-eval-secret-eval-secret!!" };
  const proposed = createProposedRunner(env);
  const ledger = proposed.ledger;
  const start = ledger.total();
  const budget = new RunBudget(ledger, limitUsd, "eval");
  const over = () => ledger.total() - start >= limitUsd * 0.98;
  const systems = values.systems!.split(",") as ("proposed" | "baseline")[];
  const result: EvalResult = {
    runId: `eval-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    split, scenarioHash: hash, createdAt: new Date().toISOString(),
    versions: { model: process.env.GEMINI_MODEL ?? "gemini-3.8-flash", prompts: { ...PROMPT_VERSIONS }, policy: POLICY.version, router: "see server startup (ROUTER=auto)" },
    systems: {}, repeats: null, spendUsd: 0, limitUsd, stoppedEarly: false, notes: [],
    ...(values.label ? { label: values.label } : {}),
  };

  const apiKey = process.env.GEMINI_API_KEY;
  for (const sys of systems) {
    if (sys === "baseline" && !apiKey) {
      result.notes.push("baseline skipped: no GEMINI_API_KEY");
      continue;
    }
    const world = createWorld();
    const baseline =
      sys === "baseline"
        ? createBaselineRunner({
            client: createGeminiFnClient(apiKey!, result.versions.model),
            tools: world.wrapTools(createTools(world.wrapServing(proposed.base), proposed.opsDb)),
            serving: proposed.base,
            ops: proposed.opsDb,
            world,
            budget,
          })
        : null;
    const rows: Row[] = [];
    for (const s of sys === "baseline" ? baselineSubset(scenarios, Number(values["baseline-share"])) : scenarios) {
      if (over()) {
        result.stoppedEarly = true;
        break;
      }
      const t = sys === "proposed" ? await proposed.run(s) : await baseline!.run(s);
      // A run-limit refusal means the scenario was not run, not that it failed: stop and leave it out.
      if (t.error?.startsWith("BUD_TOTAL")) {
        result.stoppedEarly = true;
        break;
      }
      rows.push({ s, t, g: grade(s, t) });
      process.stdout.write(`${sys} ${s.id} ${rows.at(-1)!.g.pass ? "pass" : "FAIL"} $${(ledger.total() - start).toFixed(4)}\n`);
    }
    result.systems[sys] = rows;
  }

  const k = Number(values.repeat);
  if (k > 1 && !over()) {
    const subset = scenarios.filter((s) => ["normal", "escalate", "ambiguous"].includes(s.category)).slice(0, Number(values["repeat-n"]));
    const grades: Grade[][] = subset.map((s) => (result.systems.proposed ?? []).filter((r) => r.s.id === s.id).map((r) => r.g));
    for (let i = 1; i < k && !over(); i++) for (const [j, s] of subset.entries()) if (!over()) grades[j]!.push(grade(s, await proposed.run(s)));
    result.repeats = { k, scenarioIds: subset.map((s) => s.id), grades };
  }

  result.spendUsd = ledger.total() - start;
  if (scenarios.some((s) => s.family === "dispute_fraud")) result.notes.push("The dispute_fraud candidate pool has about 5 transactions in the data; its picks repeat across scenarios and splits.");
  // Raw results hold reply texts and dataset ids: private, under data/ (gitignored). Only the aggregate report is committed.
  mkdirSync(join(ROOT, "data/eval/runs"), { recursive: true });
  writeFileSync(join(ROOT, `data/eval/runs/${result.runId}.json`), JSON.stringify(result, null, 1));
  const md = renderReport(result);
  const reportPath = values.report ?? (split === "test" ? "reports/eval.md" : "reports/eval-dev.md");
  writeFileSync(resolvePath(reportPath), md);
  console.log(`\n${result.runId}: spend $${result.spendUsd.toFixed(4)} · report ${reportPath}`);
  proposed.close();
}
