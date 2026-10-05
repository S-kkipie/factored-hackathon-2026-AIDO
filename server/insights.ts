import type { Database } from "bun:sqlite";
import type { ServingDb } from "./db/serving";
import { POLICY } from "./policy/config";
import { type ModelProduct, type ModelTransaction, toModelProduct, toModelTransaction } from "./tools/views";

/**
 * Read models behind the customer home, "my cases" and the supervision dashboard. Customer reads are always keyed
 * by the session customer (from the JWT); records go through the same field-by-field projections the model sees.
 * Supervision reads only aggregates: counts, rule ids, latencies and costs — never message text.
 */

const day = (iso: string, deltaDays: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + deltaDays * 86_400_000).toISOString().slice(0, 10);

export interface CustomerOverview {
  /** Simulated policy clock: "today" for the synthetic data. */
  asOf: string;
  customer: { firstName: string; segment: string; country: string; status: string } | null;
  products: ModelProduct[];
  recent: ModelTransaction[];
  spending30d: { category: string; usd: number; count: number }[];
  monthly: { month: string; usd: number; count: number }[];
}

export function customerOverview(serving: ServingDb, customerId: string, clock = POLICY.clock): CustomerOverview {
  const to = day(clock, 1);
  const customer = serving.customer(customerId);
  const products = serving.products(customerId);
  const recent = serving.transactions(customerId, { limit: 8, to });
  const spending30d = serving.spendingByCategory(customerId, day(clock, -29), to);
  const monthly = serving.spendingByMonth(customerId, `${day(clock, -150).slice(0, 7)}-01`);
  return {
    asOf: clock,
    customer: customer
      ? { firstName: customer.first_name, segment: customer.segment, country: customer.country, status: customer.customer_status }
      : null,
    products: products.map(toModelProduct),
    recent: recent.map(toModelTransaction),
    spending30d,
    monthly,
  };
}

export interface CustomerCase {
  kind: "dispute" | "handoff";
  id: string;
  status: "received" | "in_review" | "queued" | "taken" | "resolved";
  createdAt: string;
  resolvedAt: string | null;
  transactionIds: string[];
  amountUsd: number | null;
  reason: string | null;
}

/** The customer's own disputes and human handoffs, newest first. Rule ids and agent identities are not exposed. */
export function customerCases(ops: Database, customerId: string): CustomerCase[] {
  const disputes = ops
    .query<{ dispute_id: string; transaction_ids: string; amount_usd: number; status: string; created_at: string; reason: string }, [string]>(
      "select dispute_id, transaction_ids, amount_usd, status, created_at, reason from disputes where customer_id = ?",
    )
    .all(customerId);
  const handoffs = ops
    .query<{ handoff_id: string; status: string; created_at: string; resolved_at: string | null; card: string }, [string]>(
      "select handoff_id, status, created_at, resolved_at, card from handoffs where customer_id = ?",
    )
    .all(customerId);
  const cases: CustomerCase[] = [
    ...disputes.map((d) => ({
      kind: "dispute" as const,
      id: d.dispute_id,
      status: (d.status === "received" ? "in_review" : "received") as CustomerCase["status"],
      createdAt: d.created_at,
      resolvedAt: null,
      transactionIds: JSON.parse(d.transaction_ids) as string[],
      amountUsd: d.amount_usd,
      reason: d.reason,
    })),
    ...handoffs.map((h) => {
      const card = JSON.parse(h.card) as { verifiedFacts?: { id: string }[] };
      return {
        kind: "handoff" as const,
        id: h.handoff_id,
        status: (["queued", "taken", "resolved"].includes(h.status) ? h.status : "queued") as CustomerCase["status"],
        createdAt: h.created_at,
        resolvedAt: h.resolved_at,
        transactionIds: (card.verifiedFacts ?? []).map((f) => f.id),
        amountUsd: null,
        reason: null,
      };
    }),
  ];
  return cases.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ── supervision ────────────────────────────────────────────────────────────────────────────────────────────

/** Terminal node of a turn → outcome, in precedence order (a turn that handed off may also have responded). */
const OUTCOME_NODES: [node: string, outcome: TurnOutcomeKind][] = [
  ["bank.node.handoff", "handoff"],
  ["bank.node.verify", "dispute_created"],
  ["bank.node.respond", "answered"],
  ["bank.node.cancelled", "cancelled"],
  ["bank.node.abstain", "abstain"],
  ["bank.node.clarify", "clarify"],
  ["bank.node.greet", "greeting"],
];

export type TurnOutcomeKind = "answered" | "dispute_created" | "handoff" | "abstain" | "clarify" | "greeting" | "cancelled";

const SECURITY_RULES = ["IN_INJECTION", "PROV_001", "RS_CANARY", "RS_PII", "IN_RATE", "IN_SIZE", "TL_NONCE_USED", "TL_NONCE_MISMATCH"];

export interface OpsMetrics {
  since: string;
  sessions: number;
  turns: number;
  outcomes: Record<TurnOutcomeKind, number>;
  /** (answered + dispute_created) / turns that reached a terminal node, excluding greetings. */
  automatedResolutionRate: number | null;
  latencyMs: { p50: number | null; p95: number | null };
  llm: { calls: number; tokens: number; costUsd: number };
  disputes: { count: number; amountUsd: number };
  queue: { queued: number; taken: number; resolved: number };
  escalationsByRule: { ruleId: string; count: number }[];
  intents: { label: string; count: number; avgConfidence: number }[];
  security: { ruleId: string; count: number }[];
  hourly: { hour: string; turns: number; handoffs: number }[];
}

const percentile = (sorted: number[], p: number): number | null =>
  sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;

export function opsMetrics(ops: Database, now: Date = new Date(), windowHours = 24 * 7): OpsMetrics {
  const since = new Date(now.getTime() - windowHours * 3_600_000).toISOString();
  const sessions = ops.query<{ n: number }, [string]>("select count(*) as n from sessions where role = 'customer' and created_at >= ?").get(since);
  const spans = ops
    .query<{ trace_id: string; name: string; started_at: string; duration_ms: number; attributes: string }, [string]>(
      "select trace_id, name, started_at, duration_ms, attributes from spans where started_at >= ? order by started_at limit 50000",
    )
    .all(since);
  const disputes = ops
    .query<{ n: number; usd: number | null }, [string]>("select count(*) as n, sum(amount_usd) as usd from disputes where created_at >= ?")
    .get(since);
  const queue = ops
    .query<{ status: string; n: number }, [string]>("select status, count(*) as n from handoffs where created_at >= ? group by status")
    .all(since);
  const handoffRules = ops.query<{ rule_ids: string }, [string]>("select rule_ids from handoffs where created_at >= ?").all(since);
  const routes = ops.query<{ payload: string }, [string]>("select payload from audit_events where kind = 'route' and at >= ?").all(since);
  const security = ops
    .query<{ rule_id: string }, [string]>("select rule_id from audit_events where at >= ? and rule_id is not null and rule_id <> ''")
    .all(since);

  // Group spans into turns (one trace per turn).
  const turns = new Map<string, { names: Set<string>; start: number; end: number }>();
  const llm = { calls: 0, tokens: 0, costUsd: 0 };
  for (const s of spans) {
    const start = Date.parse(s.started_at);
    const t = turns.get(s.trace_id) ?? { names: new Set<string>(), start, end: start };
    t.names.add(s.name);
    t.start = Math.min(t.start, start);
    t.end = Math.max(t.end, start + s.duration_ms);
    turns.set(s.trace_id, t);
    if (s.name.startsWith("chat ")) {
      const a = JSON.parse(s.attributes) as Record<string, unknown>;
      llm.calls++;
      llm.tokens += Number(a["gen_ai.usage.input_tokens"] ?? 0) + Number(a["gen_ai.usage.output_tokens"] ?? 0);
      llm.costUsd += Number(a["bank.cost_usd"] ?? 0);
    }
  }
  const outcomes: Record<TurnOutcomeKind, number> = { answered: 0, dispute_created: 0, handoff: 0, abstain: 0, clarify: 0, greeting: 0, cancelled: 0 };
  const latencies: number[] = [];
  const hourly = new Map<string, { turns: number; handoffs: number }>();
  for (const t of turns.values()) {
    const outcome = OUTCOME_NODES.find(([node]) => t.names.has(node))?.[1];
    if (!outcome) continue;
    outcomes[outcome]++;
    latencies.push(t.end - t.start);
    const hour = new Date(t.start).toISOString().slice(0, 13);
    const h = hourly.get(hour) ?? { turns: 0, handoffs: 0 };
    h.turns++;
    if (outcome === "handoff") h.handoffs++;
    hourly.set(hour, h);
  }
  latencies.sort((a, b) => a - b);
  const decided = Object.entries(outcomes).filter(([k]) => k !== "greeting").reduce((s, [, n]) => s + n, 0);

  const ruleCounts = new Map<string, number>();
  for (const h of handoffRules) for (const r of JSON.parse(h.rule_ids) as string[]) ruleCounts.set(r, (ruleCounts.get(r) ?? 0) + 1);

  const intents = new Map<string, { count: number; conf: number }>();
  for (const r of routes) {
    const p = JSON.parse(r.payload) as { label?: string; confidence?: number };
    if (!p.label) continue;
    const i = intents.get(p.label) ?? { count: 0, conf: 0 };
    i.count++;
    i.conf += Number(p.confidence ?? 0);
    intents.set(p.label, i);
  }

  // Audit rows store sorted, comma-joined rule ids for multi-rule decisions.
  const securityCounts = new Map<string, number>();
  for (const row of security) {
    for (const r of row.rule_id.split(",")) if (SECURITY_RULES.includes(r)) securityCounts.set(r, (securityCounts.get(r) ?? 0) + 1);
  }

  const q = Object.fromEntries(queue.map((r) => [r.status, r.n]));
  return {
    since,
    sessions: sessions?.n ?? 0,
    turns: latencies.length,
    outcomes,
    automatedResolutionRate: decided === 0 ? null : (outcomes.answered + outcomes.dispute_created) / decided,
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    llm: { ...llm, costUsd: Math.round(llm.costUsd * 1e6) / 1e6 },
    disputes: { count: disputes?.n ?? 0, amountUsd: disputes?.usd ?? 0 },
    queue: { queued: q.queued ?? 0, taken: q.taken ?? 0, resolved: q.resolved ?? 0 },
    escalationsByRule: [...ruleCounts.entries()].map(([ruleId, count]) => ({ ruleId, count })).sort((a, b) => b.count - a.count),
    intents: [...intents.entries()]
      .map(([label, v]) => ({ label, count: v.count, avgConfidence: v.conf / v.count }))
      .sort((a, b) => b.count - a.count),
    security: [...securityCounts.entries()].map(([ruleId, count]) => ({ ruleId, count })).sort((a, b) => b.count - a.count),
    hourly: [...hourly.entries()].map(([hour, v]) => ({ hour, ...v })).sort((a, b) => a.hour.localeCompare(b.hour)),
  };
}
