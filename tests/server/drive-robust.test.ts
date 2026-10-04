import { describe, expect, test } from "bun:test";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { CheckpointTuple } from "@langchain/langgraph-checkpoint";
import { BunSqliteSaver } from "../../server/graph/checkpointer";
import { doneOf, harness, messageOf } from "./graph-harness";

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
});
