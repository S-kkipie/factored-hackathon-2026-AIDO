import { interrupt } from "@langchain/langgraph";
import { canonicalJson, sha256Hex } from "../hash";
import { render, txLine } from "../policy/templates";
import { val } from "../provenance";
import { type RuleId, isRuleId } from "../rules";
import type { HandoffCard } from "../tools";
import { ToolError, runTool } from "../tools/runtime";
import { type GraphDeps, addRules, audit } from "./deps";
import type { Confirmation, ConfirmInterrupt, TurnUpdate, TurnValues } from "./state";

/** The exact payload a confirmation nonce is bound to, rebuilt from checkpointed state on resume. */
export const confirmPayload = (s: TurnValues): ConfirmInterrupt["payload"] => ({
  transactionIds: s.targets.map((t) => t.v.transaction_id).sort(),
  reason: s.slots?.v.reason ?? "unrecognized",
});

const isConfirmation = (x: unknown): x is Confirmation =>
  typeof x === "object" &&
  x !== null &&
  typeof (x as Confirmation).approved === "boolean" &&
  typeof (x as Confirmation).interruptId === "string" &&
  typeof (x as Confirmation).payloadHash === "string";

/**
 * Out-of-band confirmation (spec 3.2 rule 5). This node has no side effects: LangGraph re-runs it on resume. The
 * nonce is issued by the turn runner after the run pauses, bound to the interrupt id and this payload.
 */
export const confirmNode = (d: GraphDeps) => async (s: TurnValues): Promise<TurnUpdate> => {
  const value: ConfirmInterrupt = {
    kind: "confirm_dispute",
    payload: confirmPayload(s),
    text: render("confirm_dispute", d.language, { transactions: s.targets.map((t) => t.v) }),
  };
  const answer: unknown = interrupt(value);
  return { confirmation: isConfirmation(answer) ? answer : { approved: false, interruptId: "", payloadHash: "" } };
};

export const afterConfirm = (s: TurnValues): string => (s.confirmation?.approved ? "create_dispute" : "cancelled");

export const cancelledNode = (d: GraphDeps) => async (s: TurnValues): Promise<TurnUpdate> => {
  audit(d, "confirm", [], { approved: false });
  return { reply: render("dispute_cancelled", d.language), outcome: "cancelled", ruleIds: s.ruleIds };
};

/**
 * The write. Idempotent per confirmation: the key is the session plus the LangGraph interrupt id.
 *
 * Defense in depth beyond the keyed Command resume (which already scopes an answer to its own interrupt task):
 * recompute the hash of what this confirmation claims to be approving from the current (checkpointed) state and
 * refuse to write on any mismatch or absence. A resume answer can only come from `confirmNode`'s own fallback or
 * from the turn runner's `resumeTurn`, which always rebuilds this hash from the payload the nonce was bound to;
 * nothing legitimate can reach here with a wrong hash, so a mismatch means the resume was stale or tampered with.
 */
export const createDisputeNode = (d: GraphDeps) => async (s: TurnValues): Promise<TurnUpdate> => {
  const interruptId = s.confirmation?.interruptId;
  const expectedHash = sha256Hex(canonicalJson(confirmPayload(s)));
  if (!interruptId || s.confirmation?.payloadHash !== expectedHash) {
    audit(d, "create_dispute", ["TL_NONCE_MISMATCH"]);
    return { forceHandoff: true, ruleIds: addRules(s.ruleIds, "TL_NONCE_MISMATCH") };
  }
  const slots = s.slots?.v ?? {};
  try {
    const { value } = await runTool("createDispute", () =>
      d.tools.createDispute({
        sessionId: d.sessionId,
        customerId: d.customerId,
        transactions: s.targets,
        reason: slots.reason ?? "unrecognized",
        customerNote: slots.note ? val(slots.note, "llm") : null,
        idempotencyKey: `${d.sessionId}:${interruptId}`,
      }),
    );
    audit(d, "create_dispute", [], { disputeId: value.v.dispute_id, transactions: value.v.transaction_ids });
    return { results: { ...s.results, dispute: value } };
  } catch (e) {
    if (!(e instanceof ToolError)) throw e;
    audit(d, "create_dispute", [e.ruleId]);
    return { forceHandoff: true, ruleIds: addRules(s.ruleIds, e.ruleId) };
  }
};

export const afterCreate = (s: TurnValues): string => (s.forceHandoff ? "handoff" : "verify");

/** Gate 6: read the case back by id; anything but an exact match hands off. */
export const verifyNode = (d: GraphDeps) => async (s: TurnValues): Promise<TurnUpdate> => {
  const created = s.results.dispute?.v;
  const back = created ? d.tools.getDispute(d.customerId, created.dispute_id) : null;
  const same =
    created !== undefined &&
    back !== null &&
    back.v.status === "received" &&
    [...back.v.transaction_ids].sort().join() === [...created.transaction_ids].sort().join();
  if (!same || !back) {
    audit(d, "verify", ["VF_READBACK"]);
    return { forceHandoff: true, ruleIds: addRules(s.ruleIds, "VF_READBACK") };
  }
  audit(d, "verify", [], { disputeId: back.v.dispute_id });
  return {
    results: { ...s.results, dispute: back },
    reply: render("dispute_created", d.language, { dispute: back.v }),
    outcome: "dispute_created",
  };
};

export const afterVerify = (s: TurnValues): string => (s.forceHandoff ? "handoff" : "__end__");

/** Structured handoff (spec 3.3): facts, actions and rule ids for a human; never the transcript. */
export const handoffNode = (d: GraphDeps) => async (s: TurnValues): Promise<TurnUpdate> => {
  const ruleIds = addRules(s.ruleIds, ...(s.decision?.ruleIds ?? [])).filter(isRuleId).slice(0, 20) as RuleId[];
  const dispute = s.results.dispute?.v;
  const card: HandoffCard = {
    summary: `Intent ${s.route?.label ?? "unknown"}; decision ${s.decision?.action ?? "none"}; rules ${ruleIds.join(", ") || "none"}.`,
    verifiedFacts: s.targets.slice(0, 20).map((t) => ({
      kind: "transaction",
      id: t.v.transaction_id,
      detail: `${txLine(t.v)} · fraud_score ${t.v.fraud_score ?? "null"}`.slice(0, 300),
    })),
    actionsTaken: dispute ? [`dispute ${dispute.dispute_id} created`] : [],
    ruleIds,
    openQuestions: s.slots?.v.reason ? [`Customer reason: ${s.slots.v.reason}`] : [],
    language: d.language,
  };
  try {
    const { value } = await runTool("createHandoff", () =>
      d.tools.createHandoff({
        sessionId: d.sessionId,
        customerId: d.customerId,
        ruleIds,
        card,
        idempotencyKey: `${d.sessionId}:turn-${d.turn}`,
      }),
    );
    d.auth.setStatus(d.sessionId, "handed_off");
    audit(d, "handoff", ruleIds, { handoffId: value.v.handoffId });
    return {
      handoffId: value.v.handoffId,
      reply: render("handoff", d.language, { handoffId: value.v.handoffId }),
      outcome: "handoff",
      ruleIds,
    };
  } catch (e) {
    if (!(e instanceof ToolError)) throw e;
    audit(d, "handoff", [...ruleIds, e.ruleId]);
    return { reply: render("handoff_failed", d.language), outcome: "handoff", ruleIds: addRules(ruleIds, e.ruleId) };
  }
};
