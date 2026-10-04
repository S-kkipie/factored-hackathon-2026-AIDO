import type { JudgeItem, Verdict } from "./judge";
import type { Label } from "./label";
import { wilson } from "./metrics";

/** Cohen's κ for two binary raters; null when undefined (no pairs, or chance agreement is 1). */
export function cohenKappa(pairs: [boolean, boolean][]): number | null {
  const n = pairs.length;
  if (n === 0) return null;
  const po = pairs.filter(([a, b]) => a === b).length / n;
  const pa = pairs.filter(([a]) => a).length / n;
  const pb = pairs.filter(([, b]) => b).length / n;
  const pe = pa * pb + (1 - pa) * (1 - pb);
  return pe === 1 ? null : (po - pe) / (1 - pe);
}

/** Human label is the reference; positive = pass. */
export function agreement(pairs: [boolean, boolean][]) {
  const pos = pairs.filter(([h]) => h);
  const neg = pairs.filter(([h]) => !h);
  return {
    n: pairs.length,
    agree: pairs.filter(([h, j]) => h === j).length,
    kappa: cohenKappa(pairs),
    tpr: pos.length ? pos.filter(([, j]) => j).length / pos.length : null,
    tnr: neg.length ? neg.filter(([, j]) => !j).length / neg.length : null,
  };
}

const f = (x: number | null, d = 2) => (x === null ? "n/a" : x.toFixed(d));
const pct = (n: number, d: number) => {
  const r = wilson(n, d);
  return r.rate === null ? "n/a" : `${(r.rate * 100).toFixed(1)}% (${((r.lo ?? 0) * 100).toFixed(1)}–${((r.hi ?? 0) * 100).toFixed(1)}) · ${n}/${d}`;
};

export function renderJudgeReport(o: { runId: string; items: JudgeItem[]; verdicts: Record<string, Verdict | null>; labels: Record<string, Label> }): string {
  const judged = o.items.filter((i) => o.verdicts[i.key]);
  const crit = ["grounded", "language", "tone", "pass"] as const;
  const lines = [
    "# Response-quality judge",
    "",
    `Judge: Gemini (\`gemini-3.8-flash\`, rubric in \`eval/judge.ts\`) over final replies of the frozen test run \`${o.runId}\`: ${judged.length} of ${o.items.length} items judged. Deterministic pass/fail (reports/eval.md) is primary; this judge scores quality only.`,
    "",
    "## Judge pass rates",
    "",
    "| System | grounded | language | tone | pass (all three) |",
    "|---|---|---|---|---|",
  ];
  for (const system of ["proposed", "baseline"] as const) {
    const vs = judged.filter((i) => i.system === system).map((i) => o.verdicts[i.key]!);
    lines.push(`| ${system} | ${crit.map((c) => pct(vs.filter((v) => v[c]).length, vs.length)).join(" | ")} |`);
  }
  const labeled = o.items.filter((i) => o.labels[i.key] && o.verdicts[i.key]);
  lines.push("", "## Agreement with human labels", "", `${labeled.length} items labeled by a team member, blind to the judge and to which system answered.`, "", "| Criterion | n | agreement | Cohen's κ | TPR | TNR |", "|---|---|---|---|---|---|");
  for (const c of crit) {
    const a = agreement(labeled.map((i) => [o.labels[i.key]![c], o.verdicts[i.key]![c]] as [boolean, boolean]));
    lines.push(`| ${c} | ${a.n} | ${a.n ? ((a.agree / a.n) * 100).toFixed(1) : "n/a"}% | ${f(a.kappa)} | ${f(a.tpr)} | ${f(a.tnr)} |`);
  }
  const k = agreement(labeled.map((i) => [o.labels[i.key]!.pass, o.verdicts[i.key]!.pass] as [boolean, boolean])).kappa;
  lines.push(
    "",
    k !== null && k >= 0.6
      ? `The overall-pass κ is ${k.toFixed(2)} ≥ 0.6: the judge is usable as a secondary quality signal.`
      : `The overall-pass κ is ${f(k)} (< 0.6 or undefined): the judge is NOT validated; treat its rates as indicative only.`,
    "",
    "Limitations: one human labeler; 50 labels; the security grader (promptfoo) is not human-validated (see reports/redteam.md).",
    "",
  );
  return lines.join("\n");
}
