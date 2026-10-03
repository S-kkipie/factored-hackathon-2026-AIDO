import type { Database } from "bun:sqlite";
import { BUDGETS, type Budgets } from "../policy/config";

export type BudgetRule = "BUD_TURNS" | "BUD_TOKENS" | "BUD_SPEND" | "BUD_SESSION";

export function checkBudget(
  ops: Database,
  sessionId: string,
  day: string,
  budgets: Budgets = BUDGETS,
): { ok: true } | { ok: false; ruleId: BudgetRule } {
  const s = ops
    .query<{ turns: number; tokens: number; status: string }, [string]>(
      "select turns, tokens, status from sessions where session_id = ?",
    )
    .get(sessionId);
  if (!s || s.status !== "active") return { ok: false, ruleId: "BUD_SESSION" };
  if (s.turns >= budgets.maxTurns) return { ok: false, ruleId: "BUD_TURNS" };
  if (s.tokens >= budgets.maxTokensPerSession) return { ok: false, ruleId: "BUD_TOKENS" };
  const spent = ops.query<{ usd: number }, [string]>("select usd from spend where day = ?").get(day)?.usd ?? 0;
  if (spent >= budgets.dailySpendUsd) return { ok: false, ruleId: "BUD_SPEND" };
  return { ok: true };
}

export function recordTurn(ops: Database, sessionId: string): void {
  const changed = ops.query("update sessions set turns = turns + 1 where session_id = ?").run(sessionId).changes;
  if (changed === 0) throw new Error(`BUD_SESSION: unknown session ${sessionId}`);
}

export function recordUsage(ops: Database, sessionId: string, day: string, tokens: number, usd: number): void {
  const changed = ops.query("update sessions set tokens = tokens + ? where session_id = ?").run(tokens, sessionId).changes;
  if (changed === 0) throw new Error(`BUD_SESSION: unknown session ${sessionId}`);
  ops
    .query("insert into spend (day, usd) values (?, ?) on conflict (day) do update set usd = usd + excluded.usd")
    .run(day, usd);
}

export class BudgetError extends Error {
  readonly ruleId = "BUD_CALLS";
  constructor(max: number) {
    super(`BUD_CALLS: more than ${max} model calls in one turn`);
  }
}

/** Per-turn model call limit. Create one per turn. */
export class CallCounter {
  private used = 0;
  constructor(private readonly max: number) {}
  take(): void {
    if (this.used >= this.max) throw new BudgetError(this.max);
    this.used++;
  }
}

export interface BreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  now?: () => number;
}

/** Stops calling a failing provider; lets one trial call through after the cooldown. */
export class CircuitBreaker {
  state: "closed" | "open" | "half_open" = "closed";
  private failures = 0;
  private openedAt = 0;
  private readonly now: () => number;

  constructor(private readonly o: BreakerOptions) {
    this.now = o.now ?? Date.now;
  }

  canCall(): boolean {
    if (this.state === "open" && this.now() - this.openedAt > this.o.cooldownMs) this.state = "half_open";
    return this.state !== "open";
  }

  success(): void {
    this.failures = 0;
    this.state = "closed";
  }

  failure(): void {
    this.failures++;
    if (this.state === "half_open" || this.failures >= this.o.failureThreshold) {
      this.state = "open";
      this.openedAt = this.now();
    }
  }
}
