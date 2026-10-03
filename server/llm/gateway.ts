import type { Database } from "bun:sqlite";
import { BudgetError, type CallCounter, type CircuitBreaker, checkBudget, recordUsage } from "../gates/budget";
import { BUDGETS, type Budgets } from "../policy/config";
import type { RuleIdWithPrefix } from "../rules";
import type { Tracer } from "../trace";
import type { PromptId } from "./prompts";
import { PROMPT_VERSIONS } from "./prompts";
import { type Llm, costUsd } from "./types";

export type ModelRule = RuleIdWithPrefix<"BUD">;

/** The model could not be used; the caller falls back to a template or escalates. Never treated as low risk. */
export class ModelUnavailable extends Error {
  constructor(
    readonly ruleId: ModelRule,
    message: string,
  ) {
    super(`${ruleId}: ${message}`);
  }
}

export interface GatewayDeps {
  llm: Llm | null;
  ops: Database;
  sessionId: string;
  safeMode: boolean;
  breaker: CircuitBreaker;
  /** One per turn: enforces BUDGETS.maxLlmCallsPerTurn. */
  counter: CallCounter;
  tracer: Tracer;
  /** Real calendar day (UTC) for the spend cap, not the simulated policy clock. */
  day: string;
  timeoutMs: number;
  budgets?: Budgets;
}

export interface ModelCall {
  system: string;
  user: string;
  json: boolean;
  maxOutputTokens: number;
}

export interface ModelGateway {
  call(purpose: PromptId, req: ModelCall): Promise<string>;
}

/**
 * Gate 1b around every model call, in order: SAFE_MODE → session/daily budgets → circuit breaker → per-turn call
 * counter → call with a hard timeout (AbortSignal) → usage and spend accounting → span.
 */
export function createGateway(d: GatewayDeps): ModelGateway {
  return {
    async call(purpose, req) {
      if (d.safeMode || d.llm === null) throw new ModelUnavailable("BUD_SAFE_MODE", "model calls are disabled");
      const llm = d.llm;
      const budget = checkBudget(d.ops, d.sessionId, d.day, d.budgets ?? BUDGETS);
      if (!budget.ok) throw new ModelUnavailable(budget.ruleId, "budget exhausted");
      if (!d.breaker.canCall()) throw new ModelUnavailable("BUD_BREAKER", "provider circuit is open");
      try {
        d.counter.take();
      } catch (e) {
        if (e instanceof BudgetError) throw new ModelUnavailable("BUD_CALLS", e.message);
        throw e;
      }

      return d.tracer.span(
        `chat ${llm.model}`,
        {
          "gen_ai.operation.name": "chat",
          "gen_ai.provider.name": "gcp.gemini",
          "gen_ai.request.model": llm.model,
          "bank.prompt.id": purpose,
          "bank.prompt.version": PROMPT_VERSIONS[purpose],
        },
        async (set) => {
          let res: Awaited<ReturnType<Llm["generate"]>>;
          try {
            res = await llm.generate({ ...req, signal: AbortSignal.timeout(d.timeoutMs) });
          } catch (e) {
            d.breaker.failure();
            throw new ModelUnavailable("BUD_PROVIDER", e instanceof Error ? e.message : String(e));
          }
          d.breaker.success();
          const usd = costUsd(res.model, res.inputTokens, res.outputTokens);
          recordUsage(d.ops, d.sessionId, d.day, res.inputTokens + res.outputTokens, usd);
          set("gen_ai.response.model", res.model);
          set("gen_ai.usage.input_tokens", res.inputTokens);
          set("gen_ai.usage.output_tokens", res.outputTokens);
          set("bank.cost_usd", usd);
          return res.text;
        },
      );
    },
  };
}
