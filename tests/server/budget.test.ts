import { describe, expect, test } from "bun:test";
import { BudgetError, CallCounter, CircuitBreaker, checkBudget, recordTurn, recordUsage } from "../../server/gates/budget";
import { consumeNonce, issueNonce } from "../../server/gates/nonce";
import { addRisk, getRisk } from "../../server/gates/risk";
import { makeDb } from "./fixtures";

async function opsWithSession(id = "s1") {
  const ops = (await makeDb());
  (await ops.run("insert into ops.sessions (session_id, customer_id, role, language, created_at, expires_at) values ($1, 'CLI-X', 'customer', 'es', '', '')", [id]));
  return ops;
}

const small = { maxTurns: 2, maxLlmCallsPerTurn: 3, maxTokensPerSession: 100, dailySpendUsd: 1 };

describe("budgets", () => {
  test("turn, token and daily spend limits", async () => {
    const ops = (await opsWithSession());
    expect((await checkBudget(ops, "s1", "2026-10-02", small))).toEqual({ ok: true });
    (await recordTurn(ops, "s1"));
    (await recordTurn(ops, "s1"));
    expect((await checkBudget(ops, "s1", "2026-10-02", small))).toEqual({ ok: false, ruleId: "BUD_TURNS" });

    const ops2 = (await opsWithSession());
    (await recordUsage(ops2, "s1", "2026-10-02", 150, 0.1));
    expect((await checkBudget(ops2, "s1", "2026-10-02", small))).toEqual({ ok: false, ruleId: "BUD_TOKENS" });

    const ops3 = (await opsWithSession());
    (await recordUsage(ops3, "s1", "2026-10-02", 1, 1.2));
    expect((await checkBudget(ops3, "s1", "2026-10-02", small))).toEqual({ ok: false, ruleId: "BUD_SPEND" });
    expect((await checkBudget(ops3, "s1", "2026-10-03", small))).toEqual({ ok: true });
  });

  test("call counter enforces the per-turn limit", async () => {
    const c = new CallCounter(2);
    c.take();
    c.take();
    expect(() => c.take()).toThrow(BudgetError);
  });

  test("circuit breaker opens after repeated failures and half-opens after cooldown", async () => {
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

  test("fails closed for missing sessions", async () => {
    const ops = (await makeDb());
    expect((await checkBudget(ops, "ghost", "2026-10-02", small))).toEqual({ ok: false, ruleId: "BUD_SESSION" });
  });

  test("recordTurn throws on missing session", async () => {
    const ops = (await makeDb());
    await expect(recordTurn(ops, "ghost")).rejects.toThrow("BUD_SESSION: unknown session ghost");
  });

  test("recordUsage throws on missing session and doesn't upsert spend", async () => {
    const ops = (await makeDb());
    await expect(recordUsage(ops, "ghost", "2026-10-02", 1, 0.1)).rejects.toThrow("BUD_SESSION: unknown session ghost");
    const spent = (await ops.one<{ usd: number }>("select usd from ops.spend where day = $1", ["2026-10-02"]));
    expect(spent).toBeFalsy();
  });

  test("circuit breaker returns to open after failure in half_open state", async () => {
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
  test("accumulates weighted signals per session", async () => {
    const ops = (await opsWithSession());
    expect((await addRisk(ops, "s1", "abstain"))).toBe(0.5);
    expect((await addRisk(ops, "s1", "injectionSignal"))).toBe(2);
    expect((await addRisk(ops, "s1", "policyDeny"))).toBe(3);
    expect((await getRisk(ops, "s1"))).toBe(3);
  });
});

describe("nonces", () => {
  const ctx = { sessionId: "s1", interruptId: "int-1", payload: { tx: ["TRX-1"], reason: "unrecognized" } };

  test("single use, bound to session, interrupt and payload", async () => {
    const ops = (await makeDb());
    const nonce = (await issueNonce(ops, ctx, 0));
    expect((await consumeNonce(ops, { ...ctx, nonce, payload: { tx: ["TRX-2"], reason: "unrecognized" } }, 1))).toEqual({
      ok: false,
      ruleId: "TL_NONCE_MISMATCH",
    });
    expect((await consumeNonce(ops, { ...ctx, sessionId: "s2", nonce }, 1))).toEqual({ ok: false, ruleId: "TL_NONCE_MISMATCH" });
    expect((await consumeNonce(ops, { ...ctx, nonce }, 1))).toEqual({ ok: true });
    expect((await consumeNonce(ops, { ...ctx, nonce }, 2))).toEqual({ ok: false, ruleId: "TL_NONCE_USED" });
  });

  test("unknown and expired nonces are rejected", async () => {
    const ops = (await makeDb());
    expect((await consumeNonce(ops, { ...ctx, nonce: "nope" }, 0))).toEqual({ ok: false, ruleId: "TL_NONCE_UNKNOWN" });
    const nonce = (await issueNonce(ops, ctx, 0, 1000));
    expect((await consumeNonce(ops, { ...ctx, nonce }, 1001))).toEqual({ ok: false, ruleId: "TL_NONCE_EXPIRED" });
  });
});

describe("nonce payload hashing", () => {
  test("payloads that differ only in key order consume successfully", async () => {
    const ops = (await makeDb());
    const nonce = (await issueNonce(ops, { sessionId: "s1", interruptId: "i", payload: { a: 1, b: { x: [1, 2], y: "z" } } }, 0));
    expect(
      (await consumeNonce(ops, { sessionId: "s1", interruptId: "i", nonce, payload: { b: { y: "z", x: [1, 2] }, a: 1 } }, 1)),
    ).toEqual({ ok: true });
  });
});

describe("fail closed on unknown or inactive sessions", () => {
  test("risk functions throw RSK_SESSION for unknown sessions", async () => {
    const ops = (await makeDb());
    await expect(getRisk(ops, "ghost")).rejects.toThrow("RSK_SESSION: unknown session ghost");
    await expect(addRisk(ops, "ghost", "abstain")).rejects.toThrow("RSK_SESSION: unknown session ghost");
  });

  test("checkBudget requires an active session", async () => {
    for (const status of ["closed", "handed_off"]) {
      const ops = (await opsWithSession());
      (await ops.run("update ops.sessions set status = $1 where session_id = 's1'", [status]));
      expect((await checkBudget(ops, "s1", "2026-10-02", small))).toEqual({ ok: false, ruleId: "BUD_SESSION" });
    }
  });
});
