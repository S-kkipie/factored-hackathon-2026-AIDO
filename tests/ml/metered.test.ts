import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { l2normalize } from "../../server/llm/embedder";
import { SpendLedger } from "../../server/llm/ledger";
import { RunBudget, SpendCapError, meteredEmbedder, meteredLlm } from "../../server/llm/metered";
import { costUsd } from "../../server/llm/types";
import { fakeLlm } from "../server/llm-fake";
import { fakeEmbedder } from "./fakes";

const ledger = (cap: number) => new SpendLedger(join(mkdtempSync(join(tmpdir(), "aido-ml-ledger-")), "s.sqlite"), cap);
const req = { system: "s", user: "u", json: true, maxOutputTokens: 100, signal: new AbortController().signal };

describe("RunBudget and metered providers", () => {
  test("records chat and embedding spend under the run's source", async () => {
    const l = ledger(3);
    const budget = new RunBudget(l, 1, "test-run");
    await meteredLlm(fakeLlm(() => "{}"), budget, "paraphrase").generate(req);
    await meteredEmbedder(fakeEmbedder(), budget, "embed").embed(["hola", "oi"]);
    expect(budget.spent()).toBeCloseTo(costUsd("gemini-3.8-flash", 100, 20) + costUsd("gemini-embedding-001", 2, 0));
  });

  test("the run limit stops a run before the project cap does, without calling the provider", async () => {
    const budget = new RunBudget(ledger(3), 0.0001, "test-run");
    const llm = fakeLlm(() => "{}");
    await expect(meteredLlm(llm, budget, "p").generate(req)).rejects.toBeInstanceOf(SpendCapError);
    expect(llm.requests.length).toBe(0);
  });

  test("the project cap applies across runs", async () => {
    const l = ledger(0.0002);
    l.record(0.0002, { model: "m", purpose: "p", source: "earlier" });
    const budget = new RunBudget(l, 1, "test-run");
    await expect(meteredEmbedder(fakeEmbedder(), budget, "e").embed(["x"])).rejects.toThrow("project LLM spend cap");
  });

  test("l2normalize returns unit vectors and leaves zero vectors alone", () => {
    expect(Math.hypot(...l2normalize([3, 4]))).toBeCloseTo(1);
    expect(l2normalize([0, 0])).toEqual([0, 0]);
  });

  test("the fake embedder puts paraphrases closer than unrelated texts", async () => {
    const { vectors } = await fakeEmbedder().embed(["cual es mi saldo", "cual es el saldo", "quiero un prestamo"]);
    const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
    expect(dot(vectors[0]!, vectors[1]!)).toBeGreaterThan(dot(vectors[0]!, vectors[2]!));
  });

  test("concurrent metered calls enforce run limit via reservation, not actual spend", async () => {
    // One call's worst-case estimate with default req
    const oneCallEstimate = costUsd("gemini-3.8-flash", Math.ceil(("s".length + "u".length) / 3), 100);
    const l = ledger(3);
    const budget = new RunBudget(l, oneCallEstimate, "test-run");

    // Fake LLM that sleeps before responding
    const llm = fakeLlm(async () => {
      await Bun.sleep(20);
      return "{}";
    });
    const metered = meteredLlm(llm, budget, "test");

    // Start two concurrent calls: both pass check() in reservation mode,
    // but only one should succeed because the second's reservation should fail
    const results = await Promise.allSettled([metered.generate(req), metered.generate(req)]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(SpendCapError);
  });

  test("after failed provider call, reservation is released so next call succeeds", async () => {
    const oneCallEstimate = costUsd("gemini-3.8-flash", Math.ceil(("s".length + "u".length) / 3), 100);
    const l = ledger(3);
    const budget = new RunBudget(l, oneCallEstimate * 2, "test-run");

    let callCount = 0;
    const llm = fakeLlm(async () => {
      callCount++;
      if (callCount === 1) throw new Error("first call fails");
      return "{}";
    });
    const metered = meteredLlm(llm, budget, "test");

    // First call fails inside the provider, but reservation is released in finally
    await expect(metered.generate(req)).rejects.toThrow("first call fails");
    expect(callCount).toBe(1);

    // Second call succeeds because reservation from first is released
    const result = await metered.generate(req);
    expect(result.text).toBe("{}");
    expect(callCount).toBe(2);
  });
});
