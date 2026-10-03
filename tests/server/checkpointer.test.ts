import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Annotation, Command, END, START, StateGraph, interrupt } from "@langchain/langgraph";
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
    const ids = all.map((t) => String(t.config.configurable?.checkpoint_id));
    expect([...ids].sort().reverse()).toEqual(ids);
    const limited = [];
    for await (const t of saver.list({ configurable: { thread_id: "t" } }, { limit: 1 })) limited.push(t);
    expect(limited.length).toBe(1);
  });
});
