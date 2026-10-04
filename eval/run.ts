import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../pipeline/config";
import { loadServerConfig } from "../server/config";
import { SpendLedger } from "../server/llm/ledger";
import { POLICY } from "../server/policy/config";
import { runAido } from "./aido";
import { geminiToolModel, runBaseline } from "./baseline";
import { fakeEvalLlm } from "./fake";
import { grade } from "./grade";
import { renderReport, summarize } from "./report";
import { type Scenario, buildScenarios, sha256Of } from "./scenarios";
import type { Grade, ScenarioResult, SystemName } from "./types";
import { closeTemplate, customerOf, ownTransactionIds, scenarioDb } from "./world";

/**
 * `bun run eval` — replays the frozen workload against AIDO and the naive baseline and writes
 * eval/runs/<runId>.json plus reports/eval.md.
 *
 *   --system=aido|baseline|both   (default both)
 *   --subset=dev|full             (default dev: one phrasing per family and language)
 *   --only=<family prefix>        run a slice
 *   --fake                        offline scripted model, AIDO only (harness check, never reported)
 *   --run-limit=<usd>             stop starting scenarios once this run spent this much (default 1.5)
 *   --freeze                      (re)write the frozen workload and its hash, then exit
 */

const DATA = join(ROOT, "eval", "data");
const SCENARIOS = join(DATA, "scenarios.json");
const HASH = join(DATA, "scenarios.sha256");

const arg = (name: string, fallback?: string) => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "true";
};

export function freeze(): string {
  mkdirSync(DATA, { recursive: true });
  const text = `${JSON.stringify(buildScenarios(), null, 2)}\n`;
  const hash = sha256Of(text);
  writeFileSync(SCENARIOS, text);
  writeFileSync(HASH, `${hash}  scenarios.json\n`);
  return hash;
}

/** The workload is frozen by hash before any run (spec 7): a changed file fails loudly. */
export function loadFrozen(): { scenarios: Scenario[]; hash: string } {
  if (!existsSync(SCENARIOS)) throw new Error("no frozen workload: run `bun run eval --freeze` first");
  const text = readFileSync(SCENARIOS, "utf8");
  const expected = readFileSync(HASH, "utf8").trim().split(/\s+/)[0];
  const hash = sha256Of(text);
  if (hash !== expected) throw new Error(`frozen workload changed: expected ${expected}, got ${hash}`);
  return { scenarios: JSON.parse(text) as Scenario[], hash };
}

export const devSubset = (all: Scenario[]) => all.filter((s) => s.id.endsWith("-1"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (arg("freeze")) {
    console.log(`frozen ${buildScenarios().length} scenarios · sha256 ${freeze()}`);
    return;
  }
  const fake = arg("fake") === "true";
  const which = (arg("system", fake ? "aido" : "both") as "aido" | "baseline" | "both");
  const systems: SystemName[] = which === "both" ? ["aido", "baseline"] : [which];
  if (fake && systems.includes("baseline")) throw new Error("--fake runs AIDO only: the baseline needs a real model");
  const subset = arg("subset", "dev")!;
  const only = arg("only");
  const runLimit = Number(arg("run-limit", "1.5"));

  const { scenarios: frozen, hash } = loadFrozen();
  let scenarios = subset === "full" ? frozen : devSubset(frozen);
  if (only) scenarios = scenarios.filter((s) => s.family.startsWith(only));

  const env: Record<string, string | undefined> = {
    ...process.env,
    JWT_SECRET: process.env.JWT_SECRET ?? "eval-secret-eval-secret-eval-secret-0000",
    ...(fake ? { GEMINI_API_KEY: "", ROUTER: "keyword" } : {}),
  };
  const cfg = loadServerConfig(env);
  if (!fake && !cfg.geminiApiKey) throw new Error("GEMINI_API_KEY is required (or use --fake for an offline harness check)");
  const ledger = new SpendLedger(cfg.spendLedgerPath, cfg.llmTotalCapUsd);
  const spentAtStart = await ledger.total();
  const toolModel = fake ? null : geminiToolModel(cfg.geminiApiKey!, cfg.geminiModel);
  const runId = `${fake ? "fake" : "eval"}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  console.log(`${runId} · ${scenarios.length} scenarios × ${systems.join("+")} · model ${fake ? "fake-eval" : cfg.geminiModel} · run limit $${runLimit}`);

  const results: ScenarioResult[] = [];
  const grades: Grade[] = [];
  let stopped = false;

  for (const s of scenarios) {
    for (const system of systems) {
      if ((await ledger.total()) - spentAtStart >= runLimit) {
        stopped = true;
        break;
      }
      let result: ScenarioResult | null = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const r =
          system === "aido"
            ? await runAido(s, { env, ledger, ...(fake ? { llm: fakeEvalLlm() } : {}) })
            : await runBaseline(s, { model: toolModel!, ledger, capUsd: cfg.llmTotalCapUsd, today: POLICY.clock });
        result = { ...r, attempts: attempt };
        if (!r.infraError || r.infraError.startsWith("BUD_TOTAL")) break;
        console.log(`  ↻ ${s.id} ${system}: ${r.infraError}; retrying in ${10 * attempt}s`);
        await sleep(10_000 * attempt);
      }
      results.push(result!);
      if (result!.infraError) {
        console.log(`  ✗ ${s.id.padEnd(30)} ${system.padEnd(8)} excluded (${result!.infraError})`);
        continue;
      }
      const probe = await scenarioDb(s);
      const own = await ownTransactionIds(probe.sql, await customerOf(probe.sql, s.persona));
      await probe.close();
      const g = grade(s, result!, { scenario: s, ownTransactionIds: own });
      grades.push(g);
      const last = result!.turns.filter((t) => t.outcome !== "no_pending_confirmation").at(-1);
      console.log(
        `  ${g.pass ? "✓" : "✗"} ${s.id.padEnd(30)} ${system.padEnd(8)} ${(last?.outcome ?? "").padEnd(16)} ${g.pass ? "" : Object.entries(g.checks).filter(([, ok]) => !ok).map(([k]) => k).join(",")}`,
      );
    }
    if (stopped) break;
  }
  await closeTemplate();

  const summaries = systems.map((sys) => summarize(sys, scenarios, results, grades));
  const meta = { runId, model: fake ? "fake-eval" : cfg.geminiModel, router: fake ? "keyword" : cfg.router, subset: `${subset}${only ? `:${only}` : ""}`, scenarioHash: hash, fake };
  mkdirSync(join(ROOT, "eval", "runs"), { recursive: true });
  writeFileSync(join(ROOT, "eval", "runs", `${runId}.json`), JSON.stringify({ meta, summaries, results, grades, stopped }, null, 2));
  const reportPath = join(ROOT, "reports", fake ? "eval-fake.md" : "eval.md");
  writeFileSync(reportPath, renderReport(meta, summaries));
  console.log(`\n${stopped ? "STOPPED at run limit · " : ""}spent $${((await ledger.total()) - spentAtStart).toFixed(4)} · ${reportPath}`);
  for (const s of summaries) console.log(`${s.system}: pass ${s.pass.k}/${s.pass.n} · unsafe ${s.unsafe.k} · missed escalations ${s.missedEscalations.k}`);
}

if (import.meta.main) await main();
