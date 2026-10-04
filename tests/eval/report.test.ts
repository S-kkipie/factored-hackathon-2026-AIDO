import { expect, test } from "bun:test";
import type { Grade } from "../../eval/grade";
import type { EvalResult } from "../../eval/main";
import type { Row } from "../../eval/metrics";
import { renderReport } from "../../eval/report";

const row = (system: "proposed" | "baseline", lang: "es" | "pt", pass: boolean, unsafe: Grade["unsafe"] = []): Row => ({
  s: { id: `x-${lang}`, family: "balance", split: "test", category: "normal", language: lang, customerId: "c", turns: [], fault: null,
    foreign: { amounts: [], merchants: [] }, gold: { outcomes: ["auto_resolve"], disputeTxIds: null, requiredRuleIds: [], mention: null } },
  t: { scenarioId: `x-${lang}`, system, turns: [{ status: 200, outcome: "answered", ruleIds: [], reply: "", interrupt: null, latencyMs: 900 }], disputes: [], handoffs: 0,
    costUsd: 0.001, canary: null, promptMarkers: [], foreignIds: [], draftRejections: [], error: null },
  g: { scenarioId: `x-${lang}`, system, outcome: "auto_resolve", pass, ungraded: false, applicable: true, resolved: pass, escalated: false, unsafe,
    checks: { outcome: true, dispute: true, rules: true, mention: pass, leak: true, canary: true, prompt: true } },
});

test("the report shows both systems, unsafe outcomes with denominators, versions and the projection label", () => {
  const r: EvalResult = {
    runId: "eval-1", split: "test", scenarioHash: "abc123", createdAt: "2026-10-04T00:00:00Z",
    versions: { model: "gemini-3.8-flash", prompts: { respond: "v1" }, policy: "p1", router: "embed-lr@1" },
    systems: { proposed: [row("proposed", "es", true), row("proposed", "pt", false)], baseline: [row("baseline", "es", true, ["wrong_dispute"]), row("baseline", "pt", true)] },
    repeats: null, spendUsd: 0.42, limitUsd: 0.6, stoppedEarly: false, notes: ["dispute_fraud pool wraps"],
  };
  const md = renderReport(r);
  expect(md).toContain("# System evaluation");
  expect(md).toContain("| Safe automated resolution |");
  expect(md).toContain("Proposed");
  expect(md).toContain("Baseline");
  expect(md).toMatch(/Unsafe outcomes[^\n]*\| 0 \/ 2/);
  expect(md).toMatch(/1 \/ 2/);
  expect(md).toContain("gemini-3.8-flash");
  expect(md).toContain("abc123");
  expect(md).toContain("projection");
  expect(md).toContain("dispute_fraud pool wraps");
  expect(md).toContain("## By language");
});
