import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Annotation, Command, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { type Sql, migrate, openPglite } from "../../server/db/sql";
import { SqlCheckpointSaver } from "../../server/graph/checkpointer";
import { makeDb } from "./fixtures";

const State = Annotation.Root({ n: Annotation<number>(), approved: Annotation<boolean | null>() });

function graph(db: Sql) {
  return new StateGraph(State)
    .addNode("inc", (s) => ({ n: s.n + 1 }))
    .addNode("ask", () => ({ approved: (interrupt({ q: "ok?" }) as { approved: boolean }).approved }))
    .addNode("act", (s) => ({ n: s.n + 10 }))
    .addEdge(START, "inc")
    .addEdge("inc", "ask")
    .addEdge("ask", "act")
    .addEdge("act", END)
    .compile({ checkpointer: new SqlCheckpointSaver(db) });
}

describe("SqlCheckpointSaver", () => {
  test("persists an interrupted run and resumes it from a fresh connection", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "aido-cp-")), "pg");
    const cfg = { configurable: { thread_id: "s1" } };

    const db1 = await openPglite(dir);
    await migrate(db1);
    const first = await graph(db1).invoke({ n: 1, approved: null }, cfg);
    expect(first.n).toBe(2);
    const pending = (first as { __interrupt__?: { id: string }[] }).__interrupt__;
    expect(pending?.length).toBe(1);
    await db1.close();

    const db2 = await openPglite(dir);
    const reopened = graph(db2);
    const state = await reopened.getState(cfg);
    expect(state.next).toEqual(["ask"]);
    expect(state.tasks[0]?.interrupts[0]?.id).toBe(pending?.[0]?.id);

    const done = await reopened.invoke(new Command({ resume: { approved: true } }), cfg);
    expect(done).toEqual({ n: 12, approved: true });
    await db2.close();
  }, 30_000); // two on-disk PGlite boots

  test("threads are isolated and deleteThread removes one", async () => {
    const db = await makeDb();
    const app = graph(db);
    await app.invoke({ n: 1, approved: null }, { configurable: { thread_id: "a" } });
    await app.invoke({ n: 5, approved: null }, { configurable: { thread_id: "b" } });
    expect((await app.getState({ configurable: { thread_id: "b" } })).values.n).toBe(6);

    await new SqlCheckpointSaver(db).deleteThread("a");
    expect((await app.getState({ configurable: { thread_id: "a" } })).values).toEqual({});
    expect((await app.getState({ configurable: { thread_id: "b" } })).values.n).toBe(6);
  });

  test("list returns newest first and honors limit", async () => {
    const db = await makeDb();
    await graph(db).invoke({ n: 1, approved: null }, { configurable: { thread_id: "t" } });
    const saver = new SqlCheckpointSaver(db);
    const all = [];
    for await (const t of saver.list({ configurable: { thread_id: "t" } })) all.push(t);
    expect(all.length).toBeGreaterThan(1);
    const ids = all.map((t) => String(t.config.configurable?.checkpoint_id));
    expect([...ids].sort().reverse()).toEqual(ids);
    const limited = [];
    for await (const t of saver.list({ configurable: { thread_id: "t" } }, { limit: 1 })) limited.push(t);
    expect(limited.length).toBe(1);
  });

  test("putWrites: special channels replace, regular channels ignore", async () => {
    const db = await makeDb();
    const saver = new SqlCheckpointSaver(db);
    const cpId = "cp-" + Date.now();
    const taskId = "task-" + Date.now();
    const cfg = {
      configurable: { thread_id: "thread1", checkpoint_id: cpId },
    };

    // Create initial checkpoint with empty state
    const checkpoint = emptyCheckpoint();
    checkpoint.id = cpId;
    const metadata = { source: "input" as const, step: 0, parents: {} };
    await saver.put(cfg, checkpoint, metadata, {});

    // First putWrites call with mixed batch: regular write "n"=1 and error
    await saver.putWrites(cfg, [["n", 1], ["__error__", { message: "first" }]], taskId);

    // Second putWrites call with same taskId and mixed batch: regular write "n"=2 and error
    await saver.putWrites(cfg, [["n", 2], ["__error__", { message: "second" }]], taskId);

    // Verify: get the checkpoint and check pendingWrites
    const tuple = await saver.getTuple(cfg);
    expect(tuple).toBeDefined();

    if (!tuple) return;
    const pending = tuple.pendingWrites;
    if (!pending) return;

    const nWrite = pending.find(([, channel]) => channel === "n");
    const errorWrite = pending.find(([, channel]) => channel === "__error__");

    // Regular write "n" should have kept its first value (insert or ignore)
    expect(nWrite?.[2]).toBe(1);

    // Error write should have second value (insert or replace)
    expect(errorWrite?.[2]).toEqual({ message: "second" });
  });
});
