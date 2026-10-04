import { describe, expect, test } from "bun:test";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { CheckpointTuple } from "@langchain/langgraph-checkpoint";
import { BunSqliteSaver } from "../../server/graph/checkpointer";
import { doneOf, harness, interruptOf, messageOf } from "./graph-harness";
import { byPurpose } from "./llm-fake";

/**
 * A saver whose "latest" read (no checkpoint_id) returns the thread's oldest checkpoint, as a stale or
 * misordered read would. Reads by id and writes are untouched, so the graph itself runs normally.
 */
class StaleLatestSaver extends BunSqliteSaver {
  override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    if (config.configurable?.checkpoint_id) return super.getTuple(config);
    let oldest: CheckpointTuple | undefined;
    for await (const t of this.list(config)) oldest = t;
    return oldest;
  }
}

describe("turn result does not depend on a fresh post-run state read", () => {
  test("a handoff turn reports the handoff even when the latest-state read is stale", async () => {
    const h = await harness();
    h.deps.checkpointer = new StaleLatestSaver(h.ops);
    const events = await h.send("Quiero hablar con un agente");
    expect(doneOf(events).outcome).toBe("handoff");
    expect(messageOf(events)).toContain("H-");
    expect(h.handoffs().length).toBe(1);
  });

  test("a turn never sends an empty reply", async () => {
    const h = await harness();
    const events = await h.send("Quiero hablar con un agente");
    expect(messageOf(events).trim().length).toBeGreaterThan(0);
  });

  test("a second turn's outcome and handoffId come from this run, not a stale snapshot of an earlier turn", async () => {
    const h = await harness({ script: byPurpose({}, "Su tarjeta PRD-A1 tiene un saldo de 1200.50 USD.") });
    h.deps.checkpointer = new StaleLatestSaver(h.ops);
    const first = await h.send("¡Hola!");
    expect(doneOf(first).outcome).toBe("greeting");
    const second = await h.send("¿Cuál es mi saldo?");
    const done = doneOf(second);
    expect(done.outcome).toBe("answered");
    expect(done.outcome).not.toBe("greeting");
    expect(done.handoffId).toBeUndefined();
  });
});

/** Persists checkpoints a little late, like a slow disk: the graph must not finish a run before they land. */
class SlowPutSaver extends BunSqliteSaver {
  override async put(...args: Parameters<BunSqliteSaver["put"]>) {
    await Bun.sleep(30);
    return super.put(...args);
  }
  override async putWrites(...args: Parameters<BunSqliteSaver["putWrites"]>) {
    await Bun.sleep(30);
    return super.putWrites(...args);
  }
}

describe("checkpoints are durable before a run returns", () => {
  test("a dispute confirmation resumes even when checkpoint writes are slow", async () => {
    const h = await harness({ script: byPurpose({ merchant: "Super Ahorro", amount: 45, reason: "unrecognized" }, "x") });
    h.deps.checkpointer = new SlowPutSaver(h.ops);
    const first = await h.send("No reconozco un cargo de 45 dólares en Super Ahorro");
    const it = interruptOf(first)!;
    expect(it).toBeTruthy();
    const done = await h.resume(it.interruptId, it.nonce, true);
    expect(doneOf(done).outcome).toBe("dispute_created");
    expect(h.disputes().length).toBe(1);
  });
});
