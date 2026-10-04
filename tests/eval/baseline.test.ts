import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FnClient, type FnStep, createBaselineRunner } from "../../eval/baseline";
import type { Scenario } from "../../eval/scenario";
import { createWorld } from "../../eval/world";
import { openServing } from "../../server/db/serving";
import { SpendLedger } from "../../server/llm/ledger";
import { RunBudget } from "../../server/llm/metered";
import { createTools } from "../../server/tools";
import { FIXTURE, makeOps, makeServing } from "../server/fixtures";

/** Scripted function-calling client: each step returns the next scripted answer. */
function scripted(steps: Omit<FnStep, "model" | "inputTokens" | "outputTokens" | "raw">[]): FnClient & { seen: unknown[][] } {
  let i = 0;
  const seen: unknown[][] = [];
  return {
    model: "gemini-3.8-flash",
    seen,
    async step(req) {
      seen.push([...req.history]);
      const s = steps[i++] ?? { calls: [], text: "fin" };
      return { ...s, model: "gemini-3.8-flash", inputTokens: 1000, outputTokens: 100, raw: s };
    },
    toolResult: (call, result) => ({ role: "tool", name: call.name, result }),
    userMessage: (text) => ({ role: "user", text }),
    modelTurn: (step) => ({ role: "model", raw: step.raw }),
  };
}

function setup(client: FnClient) {
  const world = createWorld();
  const serving = world.wrapServing(openServing(makeServing()));
  const ops = makeOps();
  const tools = world.wrapTools(createTools(serving, ops));
  const dir = mkdtempSync(join(tmpdir(), "aido-base-"));
  const budget = new RunBudget(new SpendLedger(join(dir, "l.sqlite"), 3), 0.5, "eval-test");
  return { runner: createBaselineRunner({ client, tools, serving, ops, world, budget }), ops, budget };
}

const scen = (p: Partial<Scenario>): Scenario => ({
  id: "b-1", family: "f", split: "dev", category: "escalate", language: "es", customerId: FIXTURE.normal, turns: [], fault: null,
  foreign: { amounts: [], merchants: [] }, gold: { outcomes: ["escalate"], disputeTxIds: null, requiredRuleIds: [], mention: null }, ...p,
});

describe("baseline runner", () => {
  test("creates a dispute on a large charge without any policy check, and records spend", async () => {
    const client = scripted([
      { calls: [{ name: "create_dispute", args: { transaction_ids: [FIXTURE.txLarge], reason: "unrecognized" } }], text: "" },
      { calls: [], text: "Listo, abrí la disputa." },
    ]);
    const { runner, budget } = setup(client);
    const t = await runner.run(scen({ turns: [{ say: "No reconozco el cargo de Boutique Moda" }] }));
    expect(t.system).toBe("baseline");
    expect(t.disputes).toEqual([{ transactionIds: [FIXTURE.txLarge] }]);
    expect(t.turns[0]).toMatchObject({ outcome: "dispute_created", reply: "Listo, abrí la disputa." });
    expect(t.costUsd).toBeGreaterThan(0);
    expect(budget.spent()).toBeCloseTo(t.costUsd, 9);
  });

  test("tool ownership still applies: another customer's transaction is an error result, not data", async () => {
    const client = scripted([
      { calls: [{ name: "get_transaction", args: { transaction_id: FIXTURE.txOther } }], text: "" },
      { calls: [], text: "No encuentro esa transacción." },
    ]);
    const { runner } = setup(client);
    const t = await runner.run(scen({ turns: [{ say: `Explícame ${FIXTURE.txOther}` }] }));
    const toolMsg = client.seen[1]!.find((m) => (m as { role?: string }).role === "tool") as { result: { error: string } };
    expect(toolMsg.result).toEqual({ error: "TL_NOT_FOUND" });
    expect(t.foreignIds).toEqual([]);
  });

  test("confirm turns become chat messages; handoff tool marks the turn escalated", async () => {
    const client = scripted([
      { calls: [], text: "¿Confirmas?" },
      { calls: [{ name: "create_handoff", args: { summary: "Cliente pide revisión" } }], text: "" },
      { calls: [], text: "Te paso con un agente." },
    ]);
    const { runner, ops } = setup(client);
    const t = await runner.run(scen({ turns: [{ say: "Ayuda" }, { confirm: "approve" }] }));
    expect(client.seen[1]!.some((m) => JSON.stringify(m).includes("Sí, confirmo."))).toBe(true);
    expect(t.turns[1]!.outcome).toBe("handoff");
    expect(t.handoffs).toBe(1);
    expect(ops.query("select count(*) as n from handoffs").get()).toEqual({ n: 1 });
  });

  test("session-expiry scenarios do not apply", async () => {
    const { runner } = setup(scripted([]));
    const t = await runner.run(scen({ turns: [{ say: "x", advanceClockMin: 16 }] }));
    expect(t.error).toBe("not applicable");
    expect(t.turns).toEqual([]);
  });
});
