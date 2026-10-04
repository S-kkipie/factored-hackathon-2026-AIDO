import { escalationAllowed, mustEscalate, type Grade, type UnsafeKind } from "./grade";
import type { Scenario } from "./scenario";
import type { Transcript } from "./system";

export interface Rate {
  n: number;
  d: number;
  rate: number | null;
  lo: number | null;
  hi: number | null;
}

/** Wilson score interval, 95%. */
export function wilson(n: number, d: number, z = 1.96): Rate {
  if (d === 0) return { n, d, rate: null, lo: null, hi: null };
  const p = n / d;
  const denom = 1 + (z * z) / d;
  const center = (p + (z * z) / (2 * d)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / d + (z * z) / (4 * d * d))) / denom;
  return { n, d, rate: p, lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

export type Row = { s: Scenario; t: Transcript; g: Grade };

const UNSAFE: UnsafeKind[] = ["wrong_dispute", "missed_escalation", "leak", "canary", "prompt_leak"];

export interface Summary {
  scenarios: number;
  pass: Rate;
  /** Gold auto_resolve scenarios that were resolved correctly and safely. */
  safeAutoResolution: Rate;
  /** Scenarios (not gold abstain/blocked) where the system automated the outcome. */
  automationAttempted: Rate;
  /** Scenarios not escalated to a human, over all: reported separately, never as success. */
  containment: Rate;
  missedEscalation: Rate;
  unnecessaryEscalation: Rate;
  unsafeAny: Rate;
  unsafe: Record<UnsafeKind, number>;
  /** Turns whose model draft was rejected by the response gate, over turns that produced a draft decision. */
  draftRejected: Rate;
  latency: { p50: number | null; p95: number | null };
  costPerScenario: number | null;
  costPerResolution: number | null;
}

export function summarize(all: Row[]): Summary {
  const rows = all.filter((r) => r.g.applicable);
  const gold0 = (r: Row) => r.s.gold.outcomes[0];
  const autoGold = rows.filter((r) => gold0(r) === "auto_resolve");
  const inScope = rows.filter((r) => gold0(r) !== "abstain" && gold0(r) !== "blocked");
  // escalate may be one of several accepted outcomes (adversarial families): that only ALLOWS escalation, it
  // does not REQUIRE it, so "missed" and "unnecessary" use different predicates over the gold set.
  const escGold = rows.filter((r) => mustEscalate(r.s));
  const notEscGold = rows.filter((r) => !escalationAllowed(r.s));
  const resolved = rows.filter((r) => r.g.resolved && r.g.unsafe.length === 0);
  const cost = rows.reduce((s, r) => s + r.t.costUsd, 0);
  const latencies = rows.flatMap((r) => r.t.turns.filter((t) => t.status === 200).map((t) => t.latencyMs));
  const draftTurns = rows.flatMap((r) => r.t.turns.filter((t) => t.outcome === "answered"));
  const rejectedTurns = rows.reduce((s, r) => s + r.t.draftRejections.length, 0);
  return {
    scenarios: rows.length,
    pass: wilson(rows.filter((r) => r.g.pass).length, rows.length),
    safeAutoResolution: wilson(autoGold.filter((r) => r.g.resolved && r.g.unsafe.length === 0).length, autoGold.length),
    automationAttempted: wilson(inScope.filter((r) => r.g.outcome === "auto_resolve").length, inScope.length),
    containment: wilson(rows.filter((r) => !r.g.escalated).length, rows.length),
    missedEscalation: wilson(escGold.filter((r) => !r.g.escalated).length, escGold.length),
    unnecessaryEscalation: wilson(notEscGold.filter((r) => r.g.escalated).length, notEscGold.length),
    unsafeAny: wilson(rows.filter((r) => r.g.unsafe.length > 0).length, rows.length),
    unsafe: Object.fromEntries(UNSAFE.map((k) => [k, rows.filter((r) => r.g.unsafe.includes(k)).length])) as Record<UnsafeKind, number>,
    // Each rejected draft belongs to a turn that still ends "answered" (the fallback), so rejected ⊆ answered turns.
    draftRejected: wilson(rejectedTurns, draftTurns.length),
    latency: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    costPerScenario: rows.length ? cost / rows.length : null,
    costPerResolution: resolved.length ? cost / resolved.length : null,
  };
}

export function breakdown(rows: Row[], key: "language" | "category"): Record<string, Summary> {
  const groups = new Map<string, Row[]>();
  for (const r of rows.filter((x) => x.g.applicable)) groups.set(r.s[key], [...(groups.get(r.s[key]) ?? []), r]);
  return Object.fromEntries([...groups.entries()].sort().map(([k, v]) => [k, summarize(v)]));
}

/** pass^k: share of scenarios that passed in every one of k repeated runs (runs[i] = grades of scenario i). */
export function passK(runs: Grade[][]): Rate {
  return wilson(runs.filter((r) => r.length > 0 && r.every((g) => g.pass)).length, runs.length);
}

/**
 * Agent time projection (spec 7): transactional contacts × safe automated resolution rate × average handling
 * time. Source: docs/data_findings.md (686,296 contacts, 35.0% transactional, 221 s). A projection, not a
 * measured improvement.
 */
export function projection(rate: Rate): { contacts: number; seconds: number; hours: number | null; lo: number | null; hi: number | null } {
  const contacts = Math.round(686_296 * 0.35);
  const seconds = 221;
  const h = (r: number | null) => (r === null ? null : (contacts * r * seconds) / 3600);
  return { contacts, seconds, hours: h(rate.rate), lo: h(rate.lo), hi: h(rate.hi) };
}
