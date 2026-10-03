import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallCounter, CircuitBreaker } from "../../server/gates/budget";
import { ModelUnavailable, createGateway } from "../../server/llm/gateway";
import { SpendLedger } from "../../server/llm/ledger";
import { costUsd } from "../../server/llm/types";
import { Tracer } from "../../server/trace";
import { makeOps } from "./fixtures";
import { fakeLlm } from "./llm-fake";

const tmpLedger = () => join(mkdtempSync(join(tmpdir(), "aido-ledger-")), "spend.sqlite");

describe("SpendLedger", () => {
  test("persists spend across instances and enforces a total cap", () => {
    const path = tmpLedger();
    const a = new SpendLedger(path, 0.01);
    a.record(0.004, { model: "m", purpose: "respond", source: "test" });
    const b = new SpendLedger(path, 0.01);
    expect(b.total()).toBeCloseTo(0.004);
    expect(b.allows(0.005)).toBe(true);
    expect(b.allows(0.007)).toBe(false);
  });

  test("rejects invalid caps", () => {
    expect(() => new SpendLedger(tmpLedger(), Number.NaN)).toThrow();
    expect(() => new SpendLedger(tmpLedger(), -1)).toThrow();
  });
});

describe("gateway with a total spend cap", () => {
  function setup(capUsd: number) {
    const ops = makeOps();
    ops
      .query("insert into sessions (session_id, customer_id, role, language, created_at, expires_at) values ('s1', 'C', 'customer', 'es', 'x', 'y')")
      .run();
    const llm = fakeLlm(() => '{"ok":true}');
    const ledger = new SpendLedger(tmpLedger(), capUsd);
    const gw = createGateway({
      llm,
      ops,
      sessionId: "s1",
      safeMode: false,
      breaker: new CircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 }),
      counter: new CallCounter(10),
      tracer: new Tracer(ops, "s1"),
      day: "2026-10-03",
      timeoutMs: 1000,
      ledger,
    });
    return { llm, ledger, gw };
  }
  const req = { system: "s", user: "u", json: true, maxOutputTokens: 100 };

  test("records the actual cost of every call in the ledger", async () => {
    const { gw, ledger } = setup(3);
    await gw.call("respond", req);
    await gw.call("respond", req);
    expect(ledger.total()).toBeCloseTo(2 * costUsd("gemini-3.8-flash", 100, 20));
  });

  test("refuses a call whose worst-case cost would cross the cap, without calling the provider", async () => {
    const { gw, llm } = setup(0.0001);
    const err = await gw.call("respond", req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelUnavailable);
    expect((err as ModelUnavailable).ruleId).toBe("BUD_TOTAL");
    expect(llm.requests.length).toBe(0);
  });
});
