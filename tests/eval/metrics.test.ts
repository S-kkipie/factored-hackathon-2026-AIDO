import { describe, expect, test } from "bun:test";
import type { Grade } from "../../eval/grade";
import { breakdown, passK, percentile, projection, summarize, wilson, type Row } from "../../eval/metrics";
import type { Scenario } from "../../eval/scenario";
import type { Transcript } from "../../eval/system";

const g = (p: Partial<Grade>): Grade => ({
  scenarioId: "x", system: "proposed", outcome: "auto_resolve", pass: true, ungraded: false, applicable: true, resolved: true, escalated: false, unsafe: [],
  checks: { outcome: true, dispute: true, rules: true, mention: true, leak: true, canary: true, prompt: true }, ...p,
});
const row = (lang: "es" | "pt", gold: Scenario["gold"]["outcomes"][number], grade: Partial<Grade>, cost = 0.001, latency = 100): Row => ({
  s: { id: "x", family: "f", split: "test", category: "normal", language: lang, customerId: "c", turns: [], fault: null, foreign: { amounts: [], merchants: [] },
    gold: { outcomes: [gold], disputeTxIds: null, requiredRuleIds: [], mention: null } },
  t: { scenarioId: "x", system: "proposed", turns: [{ status: 200, outcome: null, ruleIds: [], reply: "", interrupt: null, latencyMs: latency }], disputes: [], handoffs: 0,
    costUsd: cost, canary: null, promptMarkers: [], foreignIds: [], draftRejections: [], error: null } as Transcript,
  g: g(grade),
});

describe("wilson", () => {
  test("matches a known interval and handles empty denominators", () => {
    const r = wilson(8, 10);
    expect(r.rate).toBeCloseTo(0.8, 6);
    expect(r.lo!).toBeCloseTo(0.4902, 3);
    expect(r.hi!).toBeCloseTo(0.9433, 3);
    expect(wilson(0, 0)).toEqual({ n: 0, d: 0, rate: null, lo: null, hi: null });
  });
});

describe("summarize", () => {
  const rows: Row[] = [
    row("es", "auto_resolve", { resolved: true }),
    row("es", "auto_resolve", { resolved: false, pass: false, outcome: "escalate", escalated: true }),
    row("pt", "escalate", { outcome: "escalate", escalated: true, resolved: false }),
    row("pt", "escalate", { outcome: "auto_resolve", pass: false, resolved: false, unsafe: ["missed_escalation"] }),
    row("pt", "clarify", { outcome: "clarify", resolved: false }, 0.002, 300),
  ];

  test("rates use the right denominators", () => {
    const s = summarize(rows);
    expect(s.scenarios).toBe(5);
    expect(s.safeAutoResolution).toMatchObject({ n: 1, d: 2 });
    expect(s.missedEscalation).toMatchObject({ n: 1, d: 2 });
    expect(s.unnecessaryEscalation).toMatchObject({ n: 1, d: 3 });
    expect(s.containment).toMatchObject({ n: 3, d: 5 });
    expect(s.unsafeAny).toMatchObject({ n: 1, d: 5 });
    expect(s.unsafe.missed_escalation).toBe(1);
    expect(s.costPerScenario).toBeCloseTo(0.0012, 9);
    expect(s.costPerResolution).toBeCloseTo(0.006, 9);
    expect(s.latency.p50).toBe(100);
  });

  test("breakdown by language; non-applicable rows are excluded", () => {
    const b = breakdown([...rows, row("es", "blocked", { applicable: false })], "language");
    expect(b.es!.scenarios).toBe(2);
    expect(b.pt!.scenarios).toBe(3);
  });

  test("cost per resolution is null with no resolutions", () => {
    expect(summarize([rows[2]!]).costPerResolution).toBeNull();
  });

  test("escalation allowed (not required) by gold is excluded from both the missed and unnecessary denominators", () => {
    const adversarial = (outcome: "escalate" | "clarify", escalated: boolean): Row => ({
      s: {
        id: "x", family: "f", split: "test", category: "adversarial", language: "es", customerId: "c", turns: [], fault: null,
        foreign: { amounts: [], merchants: [] },
        gold: { outcomes: ["abstain", "clarify", "escalate"], disputeTxIds: null, requiredRuleIds: [], mention: null },
      },
      t: {
        scenarioId: "x", system: "proposed", turns: [{ status: 200, outcome: null, ruleIds: [], reply: "", interrupt: null, latencyMs: 100 }],
        disputes: [], handoffs: 0, costUsd: 0.001, canary: null, promptMarkers: [], foreignIds: [], draftRejections: [], error: null,
      } as Transcript,
      g: g({ outcome, escalated, resolved: false }),
    });
    const s = summarize([adversarial("escalate", true), adversarial("clarify", false)]);
    expect(s.missedEscalation).toMatchObject({ n: 0, d: 0 });
    expect(s.unnecessaryEscalation).toMatchObject({ n: 0, d: 0 });
  });
});

test("passK, percentile and projection", () => {
  expect(passK([[g({}), g({})], [g({}), g({ pass: false })]], 2)).toMatchObject({ n: 1, d: 2 });
  // A scenario with fewer than k recorded grades (the repeat loop stopped early) can never count as a pass^k
  // success, even if every grade it does have passed.
  expect(passK([[g({})], [g({}), g({})]], 2)).toMatchObject({ n: 1, d: 2 });
  expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
  expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
  expect(percentile([], 50)).toBeNull();
  const p = projection(wilson(1, 2));
  expect(p.contacts).toBe(240204);
  expect(p.hours).toBeCloseTo((240204 * 0.5 * 221) / 3600, 3);
});
