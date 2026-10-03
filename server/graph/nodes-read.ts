import type { Transaction } from "../db/serving";
import { getRisk, addRisk } from "../gates/risk";
import { responseGate } from "../gates/response";
import { withSchema } from "../gates/schema";
import { ModelUnavailable } from "../llm/gateway";
import { SpendCapError } from "../llm/metered";
import { extractSlotsPrompt, respondPrompt } from "../llm/prompts";
import { POLICY } from "../policy/config";
import { type Intent, decide } from "../policy/rules";
import { render, renderFacts } from "../policy/templates";
import { val } from "../provenance";
import { createKeywordRouter } from "../router/keyword";
import type { RouteResult } from "../router/types";
import type { RuleId } from "../rules";
import { ToolError, runTool } from "../tools/runtime";
import { toModelProduct, toModelTransaction } from "../tools/views";
import { type GraphDeps, addRules, audit } from "./deps";
import { factsFrom } from "./facts";
import { ReplySchema, type Slots, SlotsSchema, type TurnUpdate, type TurnValues } from "./state";

const intentOf = (s: TurnValues): Intent => {
  const label = s.route?.label;
  if (!label || label === "greeting") throw new Error("node reached without a routed intent");
  return label;
};

const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * Gate 2: router + calibrated confidence; injection signals raise session risk but never decide alone. A
 * SpendCapError from the configured router (its embedding call could cross the spend cap) falls back to the
 * keyword baseline for this turn only, so the turn still completes instead of failing with a 500.
 */
export const routerNode = (d: GraphDeps) => async (s: TurnValues): Promise<TurnUpdate> => {
  let route: RouteResult;
  const rules: RuleId[] = [];
  try {
    route = await d.router.route(s.message, s.language);
  } catch (e) {
    if (!(e instanceof SpendCapError)) throw e;
    route = await createKeywordRouter().route(s.message, s.language);
    rules.push("BUD_TOTAL");
  }
  if (s.injection) {
    addRisk(d.ops, d.sessionId, "injectionSignal");
    rules.push("IN_INJECTION");
  }
  const threshold = route.threshold ?? POLICY.routerThreshold;
  if (route.label !== "greeting" && route.confidence < threshold) rules.push("RT_LOW_CONFIDENCE");
  else if (route.label === "out_of_scope") rules.push("RT_OUT_OF_SCOPE");
  audit(d, "route", rules, { label: route.label, confidence: route.confidence, router: route.router });
  return { route, ruleIds: addRules(s.ruleIds, ...rules) };
};

export const afterRouter = (s: TurnValues): string => {
  const r = s.route;
  if (!r) return "clarify";
  if (r.label === "greeting") return "greet";
  if (r.confidence < (r.threshold ?? POLICY.routerThreshold)) return "clarify";
  if (r.label === "out_of_scope") return "abstain";
  if (r.label === "request_human") return "policy";
  return "extract";
};

export const greetNode = (d: GraphDeps) => async (): Promise<TurnUpdate> => ({
  reply: render("greeting", d.language),
  outcome: "greeting",
});

export const clarifyNode = (d: GraphDeps) => async (s: TurnValues): Promise<TurnUpdate> => {
  const slots = s.slots?.v ?? {};
  const hadCriteria = Boolean(slots.transactionIds?.length || slots.merchant || slots.date || slots.amount !== undefined);
  const reply =
    s.candidates.length > 1
      ? render("clarify_target", d.language, { transactions: s.candidates })
      : hadCriteria
        ? render("no_match", d.language)
        : render("clarify_intent", d.language);
  audit(d, "clarify", s.ruleIds, { candidates: s.candidates.length });
  return { reply, outcome: "clarify" };
};

export const abstainNode = (d: GraphDeps) => async (s: TurnValues): Promise<TurnUpdate> => {
  addRisk(d.ops, d.sessionId, "abstain");
  audit(d, "abstain", s.ruleIds);
  return { reply: render("abstain", d.language), outcome: "abstain" };
};

/** Gemini call 1 (+1 schema retry). Output is tagged `llm`: it can describe, never identify or authorize. */
export const extractNode = (d: GraphDeps) => async (s: TurnValues): Promise<TurnUpdate> => {
  const intent = intentOf(s);
  if (intent === "check_balance") return { slots: val<Slots>({}, "llm") };
  try {
    const prompt = extractSlotsPrompt({ intent, message: s.message, today: d.today, canary: d.canary });
    const res = await withSchema(SlotsSchema, () =>
      d.gateway.call("extract_slots", { ...prompt, json: true, maxOutputTokens: 400 }),
    );
    if (!res.ok) {
      audit(d, "extract", ["SC_INVALID"], { attempts: res.attempts });
      return { slots: val<Slots>({}, "llm"), ruleIds: addRules(s.ruleIds, "SC_INVALID") };
    }
    audit(d, "extract", [], { fields: Object.keys(res.value).sort() });
    return { slots: val(res.value, "llm") };
  } catch (e) {
    if (!(e instanceof ModelUnavailable)) throw e;
    audit(d, "extract", [e.ruleId]);
    return { forceHandoff: true, ruleIds: addRules(s.ruleIds, e.ruleId) };
  }
};

export const afterExtract = (s: TurnValues): string => (s.forceHandoff ? "handoff" : "resolve");

/**
 * Turns model-described references into `db` records through customer-scoped tools. The model's transaction ids
 * are only lookup keys: a record exists for this customer or it does not.
 */
export const resolveNode = (d: GraphDeps) => async (s: TurnValues): Promise<TurnUpdate> => {
  const intent = intentOf(s);
  if (intent !== "explain_charge" && intent !== "dispute_charge") return {};
  const slots = s.slots?.v ?? {};
  try {
    let found: Transaction[] = [];
    const explicit = Boolean(slots.transactionIds?.length);
    if (explicit) {
      for (const id of slots.transactionIds ?? []) {
        try {
          found.push((await runTool("getTransaction", () => d.tools.getTransaction(d.customerId, val(id, "llm")))).value.v);
        } catch (e) {
          if (!(e instanceof ToolError && e.ruleId === "TL_NOT_FOUND")) throw e;
        }
      }
    } else if (slots.merchant || slots.date || slots.amount !== undefined) {
      const filter = {
        merchant: slots.merchant,
        from: slots.date,
        to: slots.date ? nextDay(slots.date) : undefined,
        limit: 50,
      };
      const rows = (await runTool("searchTransactions", () => d.tools.searchTransactions(d.customerId, filter))).value.v;
      found =
        slots.amount === undefined
          ? rows
          : rows.filter((t) => Math.abs(t.amount - slots.amount!) < 0.01 || Math.abs((t.amount_usd ?? -1) - slots.amount!) < 0.01);
    }
    const unique = [...new Map(found.map((t) => [t.transaction_id, t])).values()];
    audit(d, "resolve", [], { explicit, found: unique.length });
    // Explicit ids are taken as a set (policy decides about many); a search hit must be unambiguous.
    if (explicit || unique.length === 1) return { targets: unique.map((t) => val(t, "db")), candidates: [] };
    return { targets: [], candidates: unique.slice(0, 5) };
  } catch (e) {
    if (!(e instanceof ToolError)) throw e;
    audit(d, "resolve", [e.ruleId]);
    return { forceHandoff: true, ruleIds: addRules(s.ruleIds, e.ruleId) };
  }
};

export const afterResolve = (s: TurnValues): string => {
  if (s.forceHandoff) return "handoff";
  const intent = s.route?.label;
  if (intent === "explain_charge" && s.targets.length !== 1) return "clarify";
  if (intent === "dispute_charge" && s.targets.length === 0) return "clarify";
  return "policy";
};

/** Gate 4: the pure policy engine decides; this node only gathers its `db`/`jwt` inputs. */
export const policyNode = (d: GraphDeps) => async (s: TurnValues): Promise<TurnUpdate> => {
  const intent = intentOf(s);
  const customer = d.serving.customer(d.customerId.v);
  if (!customer) {
    audit(d, "policy", ["POL_STATUS"], { reason: "customer_missing" });
    return {
      decision: { action: "escalate", ruleIds: ["POL_STATUS"], policyVersion: POLICY.version },
      ruleIds: addRules(s.ruleIds, "POL_STATUS"),
    };
  }
  const history = d.tools.getDisputeHistory(d.customerId).v;
  const decision = decide({
    intent,
    customer,
    targets: s.targets,
    disputedTransactionIds: history.disputedTransactionIds,
    repeatComplainer: history.repeatComplainer,
    riskScore: getRisk(d.ops, d.sessionId),
  });
  if (decision.ruleIds.includes("PROV_001")) addRisk(d.ops, d.sessionId, "provenanceViolation");
  if (decision.action === "deny") addRisk(d.ops, d.sessionId, "policyDeny");
  audit(d, "policy", decision.ruleIds, {
    action: decision.action,
    policyVersion: decision.policyVersion,
    targets: s.targets.map((t) => t.v.transaction_id),
  });
  return { decision, ruleIds: addRules(s.ruleIds, ...decision.ruleIds) };
};

export const afterPolicy = (s: TurnValues): string => {
  switch (s.decision?.action) {
    case "allow":
      return "fetch";
    case "confirm":
      return "confirm";
    case "clarify":
      return "clarify";
    case "deny":
      return "abstain";
    default:
      return "handoff";
  }
};

/** Gate 5 for read intents: customer-scoped tools only. */
export const fetchNode = (d: GraphDeps) => async (s: TurnValues): Promise<TurnUpdate> => {
  const intent = intentOf(s);
  const slots = s.slots?.v ?? {};
  try {
    if (intent === "check_balance") {
      return { results: { products: (await runTool("getAccounts", () => d.tools.getAccounts(d.customerId))).value } };
    }
    if (intent === "list_transactions") {
      const filter = { from: slots.from ?? slots.date, to: slots.to, merchant: slots.merchant, limit: 20 };
      return {
        results: { transactions: (await runTool("searchTransactions", () => d.tools.searchTransactions(d.customerId, filter))).value },
      };
    }
    return { results: { transactions: val(s.targets.map((t) => t.v), "db") } };
  } catch (e) {
    if (!(e instanceof ToolError)) throw e;
    audit(d, "fetch", [e.ruleId]);
    return { forceHandoff: true, ruleIds: addRules(s.ruleIds, e.ruleId) };
  }
};

export const afterFetch = (s: TurnValues): string => (s.forceHandoff ? "handoff" : "respond");

/**
 * Gemini call for the wording, then gate 7. The model sees only model views of `db` records; any reply that fails
 * the response gate (or no model at all) is replaced by the deterministic rendering of the same records.
 */
export const respondNode = (d: GraphDeps) => async (s: TurnValues): Promise<TurnUpdate> => {
  const intent = intentOf(s);
  const r = s.results;
  const facts = factsFrom({ products: r.products, transactions: r.transactions }, []);
  const fallback = renderFacts(d.language, { products: r.products?.v, transactions: r.transactions?.v });
  const rules: RuleId[] = [];
  let reply = fallback;
  try {
    const data = {
      products: r.products?.v.map(toModelProduct),
      transactions: r.transactions?.v.map(toModelTransaction),
    };
    const prompt = respondPrompt({ language: d.language, intent, data, canary: d.canary });
    const res = await withSchema(
      ReplySchema,
      () => d.gateway.call("respond", { ...prompt, json: true, maxOutputTokens: 600 }),
      1,
    );
    if (!res.ok) rules.push("SC_INVALID");
    else {
      const check = responseGate(res.value.reply, facts, { language: d.language, canary: d.canary });
      // Spec 4.2: a reply about transactions must cite at least one of them by id.
      const txs = r.transactions?.v ?? [];
      const cites = txs.length === 0 || txs.some((t) => res.value.reply.includes(t.transaction_id));
      if (check.ok && cites) reply = res.value.reply;
      else rules.push(...check.ruleIds, ...(cites ? [] : (["RS_CITE"] as const)));
      if (check.ruleIds.includes("RS_CANARY")) addRisk(d.ops, d.sessionId, "injectionSignal");
    }
  } catch (e) {
    if (!(e instanceof ModelUnavailable)) throw e;
    rules.push(e.ruleId);
  }
  audit(d, "respond", rules, { fallback: reply === fallback });
  return { reply, outcome: "answered", ruleIds: addRules(s.ruleIds, ...rules) };
};
