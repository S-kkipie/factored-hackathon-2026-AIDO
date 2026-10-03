import { appendAudit } from "../audit";
import type { Auth, Language } from "../auth";
import type { ServingDb } from "../db/serving";
import type { Sql } from "../db/sql";
import type { ModelGateway } from "../llm/gateway";
import type { Val } from "../provenance";
import type { Router } from "../router/types";
import type { RuleId } from "../rules";
import type { Tools } from "../tools";
import type { Tracer } from "../trace";

/** Everything a node may touch. Built once per turn by the turn runner; nothing here is checkpointed. */
export interface GraphDeps {
  sessionId: string;
  customerId: Val<string>;
  language: Language;
  /** Turn number after recordTurn; part of the handoff idempotency key. */
  turn: number;
  serving: ServingDb;
  ops: Sql;
  tools: Tools;
  auth: Pick<Auth, "setStatus">;
  router: Router;
  gateway: ModelGateway;
  tracer: Tracer;
  canary: string;
  /** Simulated policy clock (YYYY-MM-DD) used to resolve relative dates in slot extraction. */
  today: string;
}

/** Nodes audit decisions only: rule ids, labels, ids and counts. Never raw text or PII (gates and tools write nothing). */
export async function audit(
  d: GraphDeps,
  kind: string,
  ruleIds: readonly RuleId[],
  payload: Record<string, unknown> = {},
): Promise<void> {
  await appendAudit(d.ops, {
    sessionId: d.sessionId,
    kind,
    ruleId: ruleIds.length > 0 ? [...ruleIds].sort().join(",") : undefined,
    payload,
  });
}

export const addRules = (current: readonly RuleId[], ...more: RuleId[]): RuleId[] => [...new Set([...current, ...more])];
