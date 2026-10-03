import { ROUTER_LABELS } from "./dataset";
import type { ExperimentResult } from "./experiment";

const f = (x: number) => x.toFixed(3);
const usd = (x: number) => (x === 0 ? "$0" : `$${x.toFixed(6)}`);

/** Markdown report for reports/router.md: comparison, per-intent F1, confusion of the selected router, method. */
export function renderRouterReport(r: ExperimentResult, meta: { model: string; trainSource: string; spentUsd: number }): string {
  const lines: string[] = [];
  const w = (s = "") => lines.push(s);
  w("# Intent router comparison");
  w();
  w(`Run \`${r.runId}\` · test set ${r.routers[0]?.test.n ?? 0} hand-written utterances (frozen, hash \`${r.data.testHash.slice(0, 12)}\`) · ` +
    `train ${r.data.trainRows} / dev ${r.data.devRows} (${meta.trainSource}) · spend this run ${usd(meta.spentUsd)}.`);
  w();
  w("All utterances are team-generated synthetic data (spec 6). Numbers are measured on the frozen test set; thresholds were chosen on dev.");
  w();
  w("| Router | Macro-F1 (95% CI) | F1 ES | F1 PT | out_of_scope recall | ECE | Threshold | Coverage @τ | Misroutes @τ | p50 / p95 ms | USD / classification |");
  w("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const x of r.routers) {
    w(
      `| ${x.name}${x.name === r.selected.router ? " **(selected)**" : ""} | ${f(x.test.macroF1)} (${f(x.macroF1CI[0])}–${f(x.macroF1CI[1])}) | ` +
        `${f(x.perLanguageMacroF1.es ?? 0)} | ${f(x.perLanguageMacroF1.pt ?? 0)} | ${f(x.outOfScopeRecall)} | ${f(x.test.ece)} | ${x.threshold.toFixed(2)} | ` +
        `${f(x.atThreshold.coverage)} | ${f(x.atThreshold.misrouteRate)} | ${x.latencyMs.p50.toFixed(0)} / ${x.latencyMs.p95.toFixed(0)} | ${usd(x.usdPerClassification)} |`,
    );
  }
  w();
  w(`**Selected:** ${r.selected.router}. ${r.selected.rationale}.`);
  w();
  w("## Per-intent F1");
  w();
  w(`| Intent | ${r.routers.map((x) => x.name).join(" | ")} |`);
  w(`|---|${r.routers.map(() => "---").join("|")}|`);
  for (const l of ROUTER_LABELS) w(`| ${l} | ${r.routers.map((x) => f(x.test.perClass[l]?.f1 ?? 0)).join(" | ")} |`);
  w();
  const sel = r.routers.find((x) => x.name === r.selected.router);
  if (sel) {
    w(`## Confusion matrix — ${sel.name} (rows: gold, columns: predicted)`);
    w();
    w(`| | ${ROUTER_LABELS.join(" | ")} |`);
    w(`|---|${ROUTER_LABELS.map(() => "---").join("|")}|`);
    for (const g of ROUTER_LABELS) w(`| ${g} | ${ROUTER_LABELS.map((p) => sel.test.confusion[g]?.[p] ?? 0).join(" | ")} |`);
    w();
  }
  w("## Method");
  w();
  w(`- Embeddings: \`${meta.model}\`, 768 dimensions, L2-normalized; multinomial logistic regression with L2 = ${r.embedLr.l2} chosen on dev ` +
    `(${Object.entries(r.embedLr.devMacroF1ByL2).map(([k, v]) => `${k}: ${f(v)}`).join(", ")}), temperature ${r.embedLr.temperature} fitted on dev.`);
  w(`- Leakage control: split by seed family (${r.data.devFamilies.length} dev families); ${r.data.droppedNearTest} training rows with cosine > 0.95 to any test row were dropped; the test set is frozen by hash.`);
  w("- Thresholds: lowest confidence whose accepted dev predictions misroute ≤ 2%; below it the assistant asks a clarifying question.");
  w("- Selection rule fixed before evaluation: deployable routers only (≤ 3 chat calls per turn), out_of_scope recall ≥ 0.8, then highest macro-F1, cheaper router on a gap < 0.01.");
  w("- Limitations: the test set and the seeds were written by the same author (the coding assistant) and validated by the team member; small test set (wide CIs); Jev was not evaluated.");
  return lines.join("\n") + "\n";
}
