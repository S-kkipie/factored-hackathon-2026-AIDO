import type { Sql } from "../db/sql";
import { BUDGETS, type Budgets } from "../policy/config";
import type { RuleIdWithPrefix } from "../rules";

export type BudgetRule = Exclude<RuleIdWithPrefix<"BUD">, "BUD_CALLS">;

export async function checkBudget(
  ops: Sql,
  sessionId: string,
  day: string,
  budgets: Budgets = BUDGETS,
): Promise<{ ok: true } | { ok: false; ruleId: BudgetRule }> {
  const s = await ops.one<{ turns: number; tokens: number; status: string }>(
    "select turns, tokens, status from ops.sessions where session_id = $1",
    [sessionId],
  );
  if (!s || s.status !== "active") return { ok: false, ruleId: "BUD_SESSION" };
  if (s.turns >= budgets.maxTurns) return { ok: false, ruleId: "BUD_TURNS" };
  if (s.tokens >= budgets.maxTokensPerSession) return { ok: false, ruleId: "BUD_TOKENS" };
  const spent = (await ops.one<{ usd: number }>("select usd from ops.spend where day = $1", [day]))?.usd ?? 0;
  if (spent >= budgets.dailySpendUsd) return { ok: false, ruleId: "BUD_SPEND" };
  return { ok: true };
}

export async function recordTurn(ops: Sql, sessionId: string): Promise<void> {
  const changed = await ops.run("update ops.sessions set turns = turns + 1 where session_id = $1", [sessionId]);
  if (changed === 0) throw new Error(`BUD_SESSION: unknown session ${sessionId}`);
}

export async function recordUsage(ops: Sql, sessionId: string, day: string, tokens: number, usd: number): Promise<void> {
  const changed = await ops.run("update ops.sessions set tokens = tokens + $1 where session_id = $2", [tokens, sessionId]);
  if (changed === 0) throw new Error(`BUD_SESSION: unknown session ${sessionId}`);
  await ops.run(
    "insert into ops.spend (day, usd) values ($1, $2) on conflict (day) do update set usd = ops.spend.usd + excluded.usd",
    [day, usd],
  );
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
