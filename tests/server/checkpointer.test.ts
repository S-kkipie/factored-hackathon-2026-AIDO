import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Annotation, Command, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { openOps } from "../../server/db/ops";
import { BunSqliteSaver } from "../../server/graph/checkpointer";

const State = Annotation.Root({ n: Annotation<number>(), approved: Annotation<boolean | null>() });

function graph(db: ReturnType<typeof openOps>) {
  return new StateGraph(State)
    .addNode("inc", (s) => ({ n: s.n + 1 }))
    .addNode("ask", () => ({ approved: (interrupt({ q: "ok?" }) as { approved: boolean }).approved }))
    .addNode("act", (s) => ({ n: s.n + 10 }))
    .addEdge(START, "inc")
    .addEdge("inc", "ask")
    .addEdge("ask", "act")
    .addEdge("act", END)
    .compile({ checkpointer: new BunSqliteSaver(db) });
}

describe("BunSqliteSaver", () => {
  test("persists an interrupted run and resumes it from a fresh connection", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "aido-cp-")), "ops.sqlite");
    const cfg = { configurable: { thread_id: "s1" } };

    const first = await graph(openOps(path)).invoke({ n: 1, approved: null }, cfg);
    expect(first.n).toBe(2);
    const pending = (first as { __interrupt__?: { id: string }[] }).__interrupt__;
    expect(pending?.length).toBe(1);

    const reopened = graph(openOps(path));
    const state = await reopened.getState(cfg);
    expect(state.next).toEqual(["ask"]);
    expect(state.tasks[0]?.interrupts[0]?.id).toBe(pending?.[0]?.id);

    const done = await reopened.invoke(new Command({ resume: { approved: true } }), cfg);
    expect(done).toEqual({ n: 12, approved: true });
  });

  test("threads are isolated and deleteThread removes one", async () => {
    const db = openOps(":memory:");
    const app = graph(db);
    await app.invoke({ n: 1, approved: null }, { configurable: { thread_id: "a" } });
    await app.invoke({ n: 5, approved: null }, { configurable: { thread_id: "b" } });
    expect((await app.getState({ configurable: { thread_id: "b" } })).values.n).toBe(6);

    await new BunSqliteSaver(db).deleteThread("a");
    expect((await app.getState({ configurable: { thread_id: "a" } })).values).toEqual({});
    expect((await app.getState({ configurable: { thread_id: "b" } })).values.n).toBe(6);
  });

  test("list returns newest first and honors limit", async () => {
    const db = openOps(":memory:");
    await graph(db).invoke({ n: 1, approved: null }, { configurable: { thread_id: "t" } });
    const saver = new BunSqliteSaver(db);
    const all = [];
    for await (const t of saver.list({ configurable: { thread_id: "t" } })) all.push(t);
    expect(all.length).toBeGreaterThan(1);
    const steps = all.map((t) => Number((t.metadata as { step?: number } | undefined)?.step));
    expect([...steps].sort((x, y) => y - x)).toEqual(steps);
    const limited = [];
    for await (const t of saver.list({ configurable: { thread_id: "t" } }, { limit: 1 })) limited.push(t);
    expect(limited.length).toBe(1);
  });

  test("putWrites: special channels replace, regular channels ignore", async () => {
    const db = openOps(":memory:");
    const saver = new BunSqliteSaver(db);
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

  test("latest means last written, even when checkpoint ids are not time-ordered (wall clock stepped back)", async () => {
    const db = openOps(":memory:");
    const saver = new BunSqliteSaver(db);
    const cfg = { configurable: { thread_id: "t", checkpoint_ns: "" } };
    // Ids as observed in a real run after the WSL clock stepped back: step 2 sorts before step 1.
    const ids = ["1f1bfa00-d300-6741-ffff-14dd5872314f", "1f1bfa00-d735-61d0-8001-9dbfbf087b65", "1f1bfa00-d068-6640-8002-e22f1b1c692a"] as const;
    let parent: typeof cfg & { configurable: { checkpoint_id?: string } } = cfg;
    for (const [step, id] of ids.entries()) {
      const next = await saver.put(parent, { ...emptyCheckpoint(), id }, { source: "loop", step, parents: {} }, {});
      parent = next as typeof parent;
    }
    expect((await saver.getTuple(cfg))?.config.configurable?.checkpoint_id).toBe(ids[2]);
    const listed = [];
    for await (const t of saver.list(cfg)) listed.push(String(t.config.configurable?.checkpoint_id));
    expect(listed).toEqual([ids[2], ids[1], ids[0]]);
    const before = [];
    for await (const t of saver.list(cfg, { before: { configurable: { checkpoint_id: ids[2] } } })) before.push(String(t.config.configurable?.checkpoint_id));
    expect(before).toEqual([ids[1], ids[0]]);
  });
});

