import { END, START, StateGraph } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { GraphDeps } from "./deps";
import {
  afterConfirm,
  afterCreate,
  afterVerify,
  cancelledNode,
  confirmNode,
  createDisputeNode,
  handoffNode,
  verifyNode,
} from "./nodes-act";
import {
  abstainNode,
  afterExtract,
  afterFetch,
  afterPolicy,
  afterResolve,
  afterRouter,
  clarifyNode,
  extractNode,
  fetchNode,
  greetNode,
  policyNode,
  resolveNode,
  respondNode,
  routerNode,
} from "./nodes-read";
import { type TurnUpdate, type TurnValues, TurnState } from "./state";

/** Wraps a node in a `bank.node.<name>` span carrying the rule ids it added. */
const traced =
  (d: GraphDeps, name: string, fn: (s: TurnValues) => Promise<TurnUpdate>) =>
  (s: TurnValues): Promise<TurnUpdate> =>
    d.tracer.span(`bank.node.${name}`, { "bank.node": name }, async (set) => {
      const update = await fn(s);
      if (update.ruleIds) set("bank.rule_ids", [...update.ruleIds]);
      if (update.decision) set("bank.gate.decision", update.decision.action);
      return update;
    });

/**
 * Conversation graph (spec 4.2). Every edge is deterministic code; Gemini is reached only through the gateway in
 * `extract` and `respond`. Input and budget gates run in the turn runner before the graph so raw text is never
 * checkpointed.
 */
export function buildGraph(d: GraphDeps, checkpointer: BaseCheckpointSaver) {
  return new StateGraph(TurnState)
    .addNode("router", traced(d, "router", routerNode(d)))
    .addNode("greet", traced(d, "greet", greetNode(d)))
    .addNode("clarify", traced(d, "clarify", clarifyNode(d)))
    .addNode("abstain", traced(d, "abstain", abstainNode(d)))
    .addNode("extract", traced(d, "extract", extractNode(d)))
    .addNode("resolve", traced(d, "resolve", resolveNode(d)))
    .addNode("policy", traced(d, "policy", policyNode(d)))
    .addNode("fetch", traced(d, "fetch", fetchNode(d)))
    .addNode("respond", traced(d, "respond", respondNode(d)))
    .addNode("confirm", traced(d, "confirm", confirmNode(d)))
    .addNode("cancelled", traced(d, "cancelled", cancelledNode(d)))
    .addNode("create_dispute", traced(d, "create_dispute", createDisputeNode(d)))
    .addNode("verify", traced(d, "verify", verifyNode(d)))
    .addNode("handoff", traced(d, "handoff", handoffNode(d)))
    .addEdge(START, "router")
    .addConditionalEdges("router", afterRouter, ["greet", "clarify", "abstain", "policy", "extract"])
    .addConditionalEdges("extract", afterExtract, ["handoff", "resolve"])
    .addConditionalEdges("resolve", afterResolve, ["handoff", "clarify", "policy"])
    .addConditionalEdges("policy", afterPolicy, ["fetch", "confirm", "clarify", "abstain", "handoff"])
    .addConditionalEdges("fetch", afterFetch, ["handoff", "respond"])
    .addConditionalEdges("confirm", afterConfirm, ["create_dispute", "cancelled"])
    .addConditionalEdges("create_dispute", afterCreate, ["handoff", "verify"])
    .addConditionalEdges("verify", afterVerify, ["handoff", END])
    .addEdge("greet", END)
    .addEdge("clarify", END)
    .addEdge("abstain", END)
    .addEdge("respond", END)
    .addEdge("cancelled", END)
    .addEdge("handoff", END)
    .compile({ checkpointer });
}

export type ConversationGraph = ReturnType<typeof buildGraph>;
