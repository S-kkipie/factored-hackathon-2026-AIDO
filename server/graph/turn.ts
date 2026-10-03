import { Command } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { appendAudit } from "../audit";
import type { Auth, Session, SessionStatus } from "../auth";
import type { ServerConfig } from "../config";
import type { ServingDb } from "../db/serving";
import type { Sql } from "../db/sql";
import { CallCounter, type CircuitBreaker, checkBudget, recordTurn } from "../gates/budget";
import { injectionSignal } from "../gates/injection";
import { inputGate } from "../gates/input";
import { consumeNonce, issueNonce } from "../gates/nonce";
import { canonicalJson, sha256Hex } from "../hash";
import { createGateway } from "../llm/gateway";
import type { Llm } from "../llm/types";
import { BUDGETS, POLICY } from "../policy/config";
import { render } from "../policy/templates";
import type { Router } from "../router/types";
import type { RuleId } from "../rules";
import type { Tools } from "../tools";
import { ToolError } from "../tools/runtime";
import { Tracer } from "../trace";
import { buildGraph, type ConversationGraph } from "./build";
import type { GraphDeps } from "./deps";
import { type ConfirmInterrupt, type Confirmation, type Outcome, type TurnValues, freshTurn } from "./state";

export interface TurnDeps {
  cfg: Pick<ServerConfig, "safeMode" | "modelTimeoutMs" | "canarySecret">;
  serving: ServingDb;
  ops: Sql;
  tools: Tools;
  auth: Pick<Auth, "setStatus">;
  router: Router;
  llm: Llm | null;
  /** Shared across turns: the provider circuit is process-wide. */
  breaker: CircuitBreaker;
  checkpointer: BaseCheckpointSaver;
  now?: () => Date;
}

export type TurnOutcome = Outcome | "confirm" | "blocked" | "handed_off" | "confirmation_invalid";

/** Domain events of one turn; the AG-UI adapter maps them to protocol events. */
export type TurnEvent =
  | { type: "step"; name: string }
  | { type: "route"; label: string; confidence: number }
  | { type: "decision"; action: string; ruleIds: string[] }
  | { type: "message"; text: string }
  | { type: "interrupt"; interruptId: string; nonce: string; text: string; expiresAt: string }
  | { type: "done"; outcome: TurnOutcome; ruleIds: RuleId[] };

export type CustomerSession = Session & { status: SessionStatus };

const NONCE_TTL_MS = 10 * 60_000;

export const canaryFor = (secret: string, sessionId: string): string =>
  `cnry-${sha256Hex(`${secret}:${sessionId}`).slice(0, 12)}`;

function customerOf(session: CustomerSession) {
  if (session.role !== "customer" || !session.customerId) throw new Error("IN_ROLE: turns require a customer session");
  return session.customerId;
}

function graphFor(deps: TurnDeps, session: CustomerSession, turn: number, now: Date) {
  const tracer = new Tracer(deps.ops, session.sessionId);
  const gd: GraphDeps = {
    sessionId: session.sessionId,
    customerId: customerOf(session),
    language: session.language,
    turn,
    serving: deps.serving,
    ops: deps.ops,
    tools: deps.tools,
    auth: deps.auth,
    router: deps.router,
    tracer,
    canary: canaryFor(deps.cfg.canarySecret, session.sessionId),
    today: POLICY.clock,
    gateway: createGateway({
      llm: deps.llm,
      ops: deps.ops,
      sessionId: session.sessionId,
      safeMode: deps.cfg.safeMode,
      breaker: deps.breaker,
      counter: new CallCounter(BUDGETS.maxLlmCallsPerTurn),
      tracer,
      day: now.toISOString().slice(0, 10),
      timeoutMs: deps.cfg.modelTimeoutMs,
    }),
  };
  return { app: buildGraph(gd, deps.checkpointer), tracer };
}

const threadOf = (sessionId: string) => ({ configurable: { thread_id: sessionId } });

/** Streams one graph run, translating node updates into events; issues the nonce if the run pauses. */
export async function* drive(
  deps: TurnDeps,
  app: ConversationGraph,
  sessionId: string,
  input: Parameters<ConversationGraph["stream"]>[0],
  nowMs: number,
): AsyncGenerator<TurnEvent> {
  const cfg = threadOf(sessionId);
  let pending: { id: string; value: ConfirmInterrupt } | null = null;
  for await (const chunk of await app.stream(input, { ...cfg, streamMode: "updates" })) {
    for (const [node, update] of Object.entries(chunk as Record<string, unknown>)) {
      if (node === "__interrupt__") {
        const first = (update as { id: string; value: ConfirmInterrupt }[])[0];
        if (first) pending = first;
        continue;
      }
      yield { type: "step", name: node };
      const u = (update ?? {}) as Partial<TurnValues>;
      if (u.route) yield { type: "route", label: u.route.label, confidence: u.route.confidence };
      if (u.decision) yield { type: "decision", action: u.decision.action, ruleIds: [...u.decision.ruleIds] };
    }
  }

  const values = (await app.getState(cfg)).values as TurnValues;
  if (pending) {
    const nonce = await issueNonce(deps.ops, { sessionId, interruptId: pending.id, payload: pending.value.payload }, nowMs, NONCE_TTL_MS);
    await appendAudit(deps.ops, { sessionId, kind: "confirm_requested", payload: { interruptId: pending.id, ...pending.value.payload } });
    yield {
      type: "interrupt",
      interruptId: pending.id,
      nonce,
      text: pending.value.text,
      expiresAt: new Date(nowMs + NONCE_TTL_MS).toISOString(),
    };
    yield { type: "done", outcome: "confirm", ruleIds: values.ruleIds };
    return;
  }
  yield { type: "message", text: values.reply };
  // A graph that ended without ever setting an outcome is not a success; default to a safe clarify, not answered.
  yield { type: "done", outcome: values.outcome ?? "clarify", ruleIds: values.ruleIds };
}

/**
 * Escalation outside the graph (budget exhausted): a minimal handoff card, then the session is handed off.
 * Keyed distinctly from the graph's own `handoffNode` (`${sessionId}:turn-${turn}`): both can fire for the same
 * turn count (budget is checked before `recordTurn`), and reusing that key would collide with a different
 * payload — `TL_IDEMPOTENCY_MISMATCH`, caught below, with nothing actually queued. Returns whether the handoff
 * was actually created, so the caller can report `handoff` vs. `handoff_failed`.
 */
async function escalateDirect(deps: TurnDeps, session: CustomerSession, ruleId: RuleId, turn: number): Promise<boolean> {
  try {
    await deps.tools.createHandoff({
      sessionId: session.sessionId,
      customerId: customerOf(session),
      ruleIds: [ruleId],
      card: {
        summary: `Automation stopped: ${ruleId}.`,
        verifiedFacts: [],
        actionsTaken: [],
        ruleIds: [ruleId],
        openQuestions: [],
        language: session.language,
      },
      idempotencyKey: `${session.sessionId}:budget-${ruleId}-${turn}`,
    });
    await deps.auth.setStatus(session.sessionId, "handed_off");
    return true;
  } catch (e) {
    if (!(e instanceof ToolError)) throw e;
    await appendAudit(deps.ops, { sessionId: session.sessionId, kind: "handoff", ruleId: e.ruleId, payload: {} });
    return false;
  }
}

const turnsOf = async (ops: Sql, sessionId: string) =>
  (await ops.one<{ turns: number }>("select turns from ops.sessions where session_id = $1", [sessionId]))?.turns ?? 0;

/**
 * In-process per-session mutex (fix round 1). `runTurn` and `resumeTurn` each run their entire body — including
 * the graph stream — while holding this lock, keyed by session id, so a `resumeTurn` can never read a checkpoint
 * with `getState()` and then, after a concurrent `runTurn` on the same session has advanced the thread to a new
 * confirmation, `stream()` against that newer checkpoint instead. The keyed Command resume in `resumeTurn` and
 * the payload-hash recheck in `createDisputeNode` are additional, independent layers on top of this; this lock
 * is what removes the race itself. It only coordinates within one process: spec 8 calls for a single Cloud Run
 * instance (or session-sticky routing) for the invariant to hold, and it does not survive a process restart.
 */
const sessionLocks = new Map<string, Promise<void>>();

async function* withSessionLock(sessionId: string, run: () => AsyncGenerator<TurnEvent>): AsyncGenerator<TurnEvent> {
  const prior = sessionLocks.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = prior.then(() => mine);
  sessionLocks.set(sessionId, chain);
  await prior;
  try {
    yield* run();
  } finally {
    release();
    if (sessionLocks.get(sessionId) === chain) sessionLocks.delete(sessionId);
  }
}

/**
 * One customer turn. Order (spec 4.5): session → budget → input gate (size, rate, PII mask) → turn count →
 * injection signal → graph. Raw text never reaches the checkpoint, the audit log or a span.
 */
export function runTurn(deps: TurnDeps, session: CustomerSession, text: string): AsyncGenerator<TurnEvent> {
  return withSessionLock(session.sessionId, () => runTurnLocked(deps, session, text));
}

async function* runTurnLocked(deps: TurnDeps, session: CustomerSession, text: string): AsyncGenerator<TurnEvent> {
  customerOf(session);
  const now = (deps.now ?? (() => new Date()))();
  const sid = session.sessionId;
  const lang = session.language;

  if (session.status === "handed_off") {
    const gate = await inputGate(deps.ops, sid, text, now.getTime());
    if (!gate.ok) {
      await appendAudit(deps.ops, { sessionId: sid, kind: "input_gate", ruleId: gate.ruleId, payload: {} });
      yield { type: "message", text: render("blocked_input", lang) };
      yield { type: "done", outcome: "blocked", ruleIds: [gate.ruleId] };
      return;
    }
    await deps.ops.run("insert into ops.messages (session_id, author, text, at) values ($1, 'customer', $2, $3)", [
      sid,
      gate.text,
      now.toISOString(),
    ]);
    yield { type: "message", text: render("handed_off", lang) };
    yield { type: "done", outcome: "handed_off", ruleIds: [] };
    return;
  }

  const budget = await checkBudget(deps.ops, sid, now.toISOString().slice(0, 10));
  if (!budget.ok) {
    await appendAudit(deps.ops, { sessionId: sid, kind: "budget", ruleId: budget.ruleId, payload: {} });
    const escalated = await escalateDirect(deps, session, budget.ruleId, await turnsOf(deps.ops, sid));
    yield { type: "message", text: render(escalated ? "budget_exhausted" : "handoff_failed", lang) };
    yield { type: "done", outcome: escalated ? "handoff" : "handoff_failed", ruleIds: [budget.ruleId] };
    return;
  }

  const gate = await inputGate(deps.ops, sid, text, now.getTime());
  if (!gate.ok) {
    await appendAudit(deps.ops, { sessionId: sid, kind: "input_gate", ruleId: gate.ruleId, payload: {} });
    yield { type: "message", text: render("blocked_input", lang) };
    yield { type: "done", outcome: "blocked", ruleIds: [gate.ruleId] };
    return;
  }
  await recordTurn(deps.ops, sid);
  const turn = await turnsOf(deps.ops, sid);
  await appendAudit(deps.ops, { sessionId: sid, kind: "input_gate", payload: { turn, pii: gate.piiFound } });

  const { app } = graphFor(deps, session, turn, now);
  yield* drive(deps, app, sid, freshTurn(gate.text, lang, injectionSignal(gate.text)), now.getTime());
}

export interface ResumeInput {
  interruptId: string;
  nonce: string;
  approved: boolean;
}

/**
 * Resumes a paused confirmation. The payload the nonce must match is rebuilt from the checkpoint, never taken
 * from the client; a stale interrupt (superseded by a newer message) or a reused nonce changes nothing.
 */
export function resumeTurn(deps: TurnDeps, session: CustomerSession, r: ResumeInput): AsyncGenerator<TurnEvent> {
  return withSessionLock(session.sessionId, () => resumeTurnLocked(deps, session, r));
}

async function* resumeTurnLocked(deps: TurnDeps, session: CustomerSession, r: ResumeInput): AsyncGenerator<TurnEvent> {
  customerOf(session);
  const now = (deps.now ?? (() => new Date()))();
  const sid = session.sessionId;
  const { app } = graphFor(deps, session, await turnsOf(deps.ops, sid), now);
  const state = await app.getState(threadOf(sid));
  const pending = state.tasks.flatMap((t) => t.interrupts).find((i) => i.id === r.interruptId);

  const invalid = async function* (ruleId: RuleId): AsyncGenerator<TurnEvent> {
    await appendAudit(deps.ops, { sessionId: sid, kind: "confirm_rejected", ruleId, payload: { interruptId: r.interruptId } });
    yield { type: "message", text: render("confirmation_invalid", session.language) };
    yield { type: "done", outcome: "confirmation_invalid", ruleIds: [ruleId] };
  };

  if (session.status !== "active") return yield* invalid("IN_SESSION_REVOKED");
  if (!pending) return yield* invalid("TL_NONCE_MISMATCH");
  const payload = (pending.value as ConfirmInterrupt).payload;
  const nonce = await consumeNonce(deps.ops, { sessionId: sid, interruptId: r.interruptId, payload, nonce: r.nonce }, now.getTime());
  if (!nonce.ok) return yield* invalid(nonce.ruleId);
  await appendAudit(deps.ops, { sessionId: sid, kind: "confirm_answered", payload: { interruptId: r.interruptId, approved: r.approved } });

  const payloadHash = sha256Hex(canonicalJson(payload));
  const answer: Confirmation = { approved: r.approved, interruptId: r.interruptId, payloadHash };
  // Keyed by the interrupt's own id (an XXH3 hash of its checkpoint namespace, per @langchain/langgraph's
  // Command(resume=) map form): this resume value can only ever be consumed by *this* interrupt's task, never
  // by a newer confirmation a racing runTurn moved the thread to after the `getState` call above.
  yield* drive(deps, app, sid, new Command({ resume: { [r.interruptId]: answer } }), now.getTime());
}
