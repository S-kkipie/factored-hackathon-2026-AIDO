import { describe, expect, test } from "bun:test";
import { BudgetError, CallCounter, CircuitBreaker, checkBudget, recordTurn, recordUsage } from "../../server/gates/budget";
import { consumeNonce, issueNonce } from "../../server/gates/nonce";
import { addRisk, getRisk } from "../../server/gates/risk";
import { makeOps } from "./fixtures";

function opsWithSession(id = "s1") {
  const ops = makeOps();
  ops
    .query("insert into sessions (session_id, customer_id, role, language, created_at, expires_at) values (?, 'CLI-X', 'customer', 'es', '', '')")
    .run(id);
  return ops;
}

const small = { maxTurns: 2, maxLlmCallsPerTurn: 3, maxTokensPerSession: 100, dailySpendUsd: 1 };

describe("budgets", () => {
  test("turn, token and daily spend limits", () => {
    const ops = opsWithSession();
    expect(checkBudget(ops, "s1", "2026-10-02", small)).toEqual({ ok: true });
    recordTurn(ops, "s1");
    recordTurn(ops, "s1");
    expect(checkBudget(ops, "s1", "2026-10-02", small)).toEqual({ ok: false, ruleId: "BUD_TURNS" });

    const ops2 = opsWithSession();
    recordUsage(ops2, "s1", "2026-10-02", 150, 0.1);
    expect(checkBudget(ops2, "s1", "2026-10-02", small)).toEqual({ ok: false, ruleId: "BUD_TOKENS" });

    const ops3 = opsWithSession();
    recordUsage(ops3, "s1", "2026-10-02", 1, 1.2);
    expect(checkBudget(ops3, "s1", "2026-10-02", small)).toEqual({ ok: false, ruleId: "BUD_SPEND" });
    expect(checkBudget(ops3, "s1", "2026-10-03", small)).toEqual({ ok: true });
  });

  test("call counter enforces the per-turn limit", () => {
    const c = new CallCounter(2);
    c.take();
    c.take();
    expect(() => c.take()).toThrow(BudgetError);
  });

  test("circuit breaker opens after repeated failures and half-opens after cooldown", () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: () => now });
    b.failure();
    expect(b.canCall()).toBe(true);
    b.failure();
    expect(b.state).toBe("open");
    expect(b.canCall()).toBe(false);
    now = 1001;
    expect(b.canCall()).toBe(true);
    expect(b.state).toBe("half_open");
    b.success();
    expect(b.state).toBe("closed");
  });

  test("fails closed for missing sessions", () => {
    const ops = makeOps();
    expect(checkBudget(ops, "ghost", "2026-10-02", small)).toEqual({ ok: false, ruleId: "BUD_SESSION" });
  });

  test("recordTurn throws on missing session", () => {
    const ops = makeOps();
    expect(() => recordTurn(ops, "ghost")).toThrow("BUD_SESSION: unknown session ghost");
  });

  test("recordUsage throws on missing session and doesn't upsert spend", () => {
    const ops = makeOps();
    expect(() => recordUsage(ops, "ghost", "2026-10-02", 1, 0.1)).toThrow("BUD_SESSION: unknown session ghost");
    const spent = ops.query<{ usd: number }, [string]>("select usd from spend where day = ?").get("2026-10-02");
    expect(spent).toBeFalsy();
  });

  test("circuit breaker returns to open after failure in half_open state", () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: () => now });
    b.failure();
    b.failure();
    expect(b.state).toBe("open");
    now = 1001;
    b.canCall(); // transitions to half_open
    expect(b.state).toBe("half_open");
    b.failure(); // failure in half_open returns to open
    expect(b.state).toBe("open");
    expect(b.canCall()).toBe(false);
  });
});

describe("risk score", () => {
  test("accumulates weighted signals per session", () => {
    const ops = opsWithSession();
    expect(addRisk(ops, "s1", "abstain")).toBe(0.5);
    expect(addRisk(ops, "s1", "injectionSignal")).toBe(2);
    expect(addRisk(ops, "s1", "policyDeny")).toBe(3);
    expect(getRisk(ops, "s1")).toBe(3);
  });
});

describe("nonces", () => {
  const ctx = { sessionId: "s1", interruptId: "int-1", payload: { tx: ["TRX-1"], reason: "unrecognized" } };

  test("single use, bound to session, interrupt and payload", () => {
    const ops = makeOps();
    const nonce = issueNonce(ops, ctx, 0);
    expect(consumeNonce(ops, { ...ctx, nonce, payload: { tx: ["TRX-2"], reason: "unrecognized" } }, 1)).toEqual({
      ok: false,
      ruleId: "TL_NONCE_MISMATCH",
    });
    expect(consumeNonce(ops, { ...ctx, sessionId: "s2", nonce }, 1)).toEqual({ ok: false, ruleId: "TL_NONCE_MISMATCH" });
    expect(consumeNonce(ops, { ...ctx, nonce }, 1)).toEqual({ ok: true });
    expect(consumeNonce(ops, { ...ctx, nonce }, 2)).toEqual({ ok: false, ruleId: "TL_NONCE_USED" });
  });

  test("unknown and expired nonces are rejected", () => {
    const ops = makeOps();
    expect(consumeNonce(ops, { ...ctx, nonce: "nope" }, 0)).toEqual({ ok: false, ruleId: "TL_NONCE_UNKNOWN" });
    const nonce = issueNonce(ops, ctx, 0, 1000);
    expect(consumeNonce(ops, { ...ctx, nonce }, 1001)).toEqual({ ok: false, ruleId: "TL_NONCE_EXPIRED" });
  });
});

describe("nonce payload hashing", () => {
  test("payloads that differ only in key order consume successfully", () => {
    const ops = makeOps();
    const nonce = issueNonce(ops, { sessionId: "s1", interruptId: "i", payload: { a: 1, b: { x: [1, 2], y: "z" } } }, 0);
    expect(
      consumeNonce(ops, { sessionId: "s1", interruptId: "i", nonce, payload: { b: { y: "z", x: [1, 2] }, a: 1 } }, 1),
    ).toEqual({ ok: true });
  });
});
