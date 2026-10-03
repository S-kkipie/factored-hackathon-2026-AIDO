import { verifyAuditChain } from "../../server/audit";
import { createAuth, type Language } from "../../server/auth";
import { openServing } from "../../server/db/serving";
import { CircuitBreaker } from "../../server/gates/budget";
import { BunSqliteSaver } from "../../server/graph/checkpointer";
import { type TurnDeps, type TurnEvent, resumeTurn, runTurn } from "../../server/graph/turn";
import type { Llm } from "../../server/llm/types";
import { createKeywordRouter } from "../../server/router/keyword";
import { createTools } from "../../server/tools";
import { makeOps, makeServing } from "./fixtures";
import { type Script, fakeLlm } from "./llm-fake";

export const AUTH_CFG = {
  jwtSecret: new TextEncoder().encode("test-secret-test-secret-test-secret!"),
  sessionTtlSeconds: 900,
  demoPin: "2468",
  agentPin: "1357",
};

export async function collect(gen: AsyncGenerator<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

export const messageOf = (events: TurnEvent[]) =>
  events.filter((e): e is Extract<TurnEvent, { type: "message" }> => e.type === "message").map((e) => e.text).join("\n");
export const doneOf = (events: TurnEvent[]) => events.find((e): e is Extract<TurnEvent, { type: "done" }> => e.type === "done")!;
export const interruptOf = (events: TurnEvent[]) =>
  events.find((e): e is Extract<TurnEvent, { type: "interrupt" }> => e.type === "interrupt");

export interface HarnessOptions {
  script?: Script;
  llm?: Llm | null;
  persona?: string;
  language?: Language;
  safeMode?: boolean;
}

/** A logged-in customer with real tools, policy, router, checkpointer and audit; only the model is scripted. */
export async function harness(o: HarnessOptions = {}) {
  const ops = makeOps();
  const serving = openServing(makeServing());
  const auth = createAuth(AUTH_CFG, serving, ops);
  const { token, session } = await auth.login(o.persona ?? "normal", "2468", o.language ?? "es");
  const llm = o.llm === undefined ? fakeLlm(o.script ?? (() => "{}")) : o.llm;
  const deps: TurnDeps = {
    cfg: { safeMode: o.safeMode ?? false, modelTimeoutMs: 1000, canarySecret: "canary-secret" },
    serving,
    ops,
    tools: createTools(serving, ops),
    auth,
    router: createKeywordRouter(),
    llm,
    breaker: new CircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 }),
    checkpointer: new BunSqliteSaver(ops),
  };
  const current = () => auth.verify(token, ["active", "handed_off"]);
  return {
    ops,
    auth,
    deps,
    llm,
    sessionId: session.sessionId,
    send: async (text: string) => collect(runTurn(deps, await current(), text)),
    resume: async (interruptId: string, nonce: string, approved: boolean) =>
      collect(resumeTurn(deps, await current(), { interruptId, nonce, approved })),
    status: () =>
      ops.query<{ status: string }, [string]>("select status from sessions where session_id = ?").get(session.sessionId)?.status,
    risk: () =>
      ops.query<{ r: number }, [string]>("select risk_score as r from sessions where session_id = ?").get(session.sessionId)?.r,
    disputes: () => ops.query<{ dispute_id: string; transaction_ids: string }, []>("select dispute_id, transaction_ids from disputes").all(),
    handoffs: () => ops.query<{ handoff_id: string; rule_ids: string; card: string }, []>("select handoff_id, rule_ids, card from handoffs").all(),
    auditOk: () => verifyAuditChain(ops).ok,
  };
}
