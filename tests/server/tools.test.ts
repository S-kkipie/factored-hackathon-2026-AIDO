import { describe, expect, test } from "bun:test";
import { openServing } from "../../server/db/serving";
import { ProvenanceError, val } from "../../server/provenance";
import { createTools, sanitizeNote } from "../../server/tools";
import { ToolError, runTool } from "../../server/tools/runtime";
import { FIXTURE, makeDb } from "./fixtures";

const me = val(FIXTURE.normal, "jwt");

async function setup() {
  const ops = (await makeDb());
  return { ops, tools: createTools(openServing(ops), ops) };
}

describe("runTool", () => {
  test("retries transient failures and reports attempts", async () => {
    let calls = 0;
    const r = await runTool("flaky", () => {
      calls++;
      if (calls < 3) throw new Error("busy");
      return "ok";
    }, { backoffMs: 1 });
    expect(r).toEqual({ value: "ok", attempts: 3 });
  });

  test("times out and fails with TL_FAIL after bounded retries", async () => {
    let calls = 0;
    const p = runTool("slow", () => {
      calls++;
      return new Promise<never>(() => {});
    }, { timeoutMs: 10, retries: 2, backoffMs: 1 });
    await expect(p).rejects.toMatchObject({ ruleId: "TL_FAIL", tool: "slow" });
    expect(calls).toBe(3);
  });

  test("does not retry provenance or non-retryable tool errors", async () => {
    let calls = 0;
    await expect(
      runTool("x", () => {
        calls++;
        throw new ProvenanceError("customerId", "llm");
      }),
    ).rejects.toBeInstanceOf(ProvenanceError);
    expect(calls).toBe(1);
  });
});

describe("tools", () => {
  test("reads are scoped to the session customer and tagged db", async () => {
    const { tools } = await setup();
    expect((await tools.getTransaction(me, val(FIXTURE.txSmall, "llm")))).toMatchObject({ src: "db", v: { amount_usd: 45 } });
    await expect(tools.getTransaction(me, val(FIXTURE.txOther, "user"))).rejects.toThrow(ToolError);
    expect((await tools.searchTransactions(me, { merchant: "uber" })).v.map((t) => t.transaction_id)).toEqual([FIXTURE.txFraud]);
  });

  test("rejects identity values that did not come from the JWT", async () => {
    const { tools } = await setup();
    await expect(tools.getAccounts(val(FIXTURE.normal, "llm"))).rejects.toThrow(ProvenanceError);
    await expect(tools.searchTransactions(val(FIXTURE.repeat, "user"), {})).rejects.toThrow("PROV_001");
  });

  test("createDispute requires db-sourced transactions owned by the customer and is idempotent", async () => {
    const { tools, ops } = await setup();
    const tx = (await tools.getTransaction(me, val(FIXTURE.txSmall, "user")));
    const input = {
      sessionId: "s1",
      customerId: me,
      transactions: [tx],
      reason: "unrecognized" as const,
      customerNote: val("No reconozco <script>alert(1)</script> este cargo\u0007", "user" as const),
      idempotencyKey: "s1:int-1",
    };
    const first = (await tools.createDispute(input));
    const second = (await tools.createDispute(input));
    expect(first.v.dispute_id).toMatch(/^D-[0-9A-F]{12}$/);
    expect(second.v.dispute_id).toBe(first.v.dispute_id);
    expect(first.v).toMatchObject({ amount_usd: 45, status: "received", transaction_ids: [FIXTURE.txSmall] });
    expect(first.v.customer_note).toBe("No reconozco scriptalert(1)/script este cargo");
    expect((await ops.one<{ n: number }>("select count(*)::int as n from ops.disputes"))?.n).toBe(1);
    expect((await ops.one<{ u: number }>("select note_untrusted as u from ops.disputes"))?.u).toBe(1);

    const forged = { ...input, idempotencyKey: "s1:int-2", transactions: [val(tx.v, "llm" as const)] };
    await expect(tools.createDispute(forged)).rejects.toThrow("PROV_001");
  });

  test("createDispute refuses transactions of another customer even if db-sourced", async () => {
    const { tools } = await setup();
    const otherDb = await makeDb();
    const other = await createTools(openServing(otherDb), otherDb).getTransaction(
      val(FIXTURE.repeat, "jwt"),
      val(FIXTURE.txOther, "user"),
    );
    await expect(
      tools.createDispute({
        sessionId: "s1",
        customerId: me,
        transactions: [other],
        reason: "unrecognized",
        customerNote: null,
        idempotencyKey: "k",
      }),
    ).rejects.toThrow("TL_OWNER");
  });

  test("getDispute is scoped and history includes created disputes", async () => {
    const { tools } = await setup();
    const tx = (await tools.getTransaction(me, val(FIXTURE.txSmall, "user")));
    const d = (await tools.createDispute({
      sessionId: "s1",
      customerId: me,
      transactions: [tx],
      reason: "duplicate",
      customerNote: null,
      idempotencyKey: "k1",
    }));
    expect((await tools.getDispute(me, d.v.dispute_id))?.v.dispute_id).toBe(d.v.dispute_id);
    expect((await tools.getDispute(val(FIXTURE.repeat, "jwt"), d.v.dispute_id))).toBeNull();
    expect((await tools.getDisputeHistory(me)).v.disputedTransactionIds).toEqual([FIXTURE.txSmall]);
    expect((await tools.getDisputeHistory(val(FIXTURE.repeat, "jwt"))).v.repeatComplainer).toBe(true);
  });

  test("createHandoff stores a structured card", async () => {
    const { tools, ops } = await setup();
    const h = (await tools.createHandoff({
      sessionId: "s1",
      customerId: me,
      ruleIds: ["POL_DSP_AMOUNT"],
      idempotencyKey: "s1:handoff-1",
      card: {
        summary: "Disputa de cargo alto",
        verifiedFacts: [{ kind: "transaction", id: FIXTURE.txLarge, detail: "USD 700 Boutique Moda" }],
        actionsTaken: [],
        ruleIds: ["POL_DSP_AMOUNT"],
        openQuestions: ["¿Reconoce el comercio?"],
        language: "es",
      },
    }));
    expect(h.v.handoffId).toMatch(/^H-/);
    expect((await ops.one<{ status: string }>("select status from ops.handoffs"))?.status).toBe("queued");
  });

  test("sanitizeNote strips control characters and markup, caps length", async () => {
    expect(sanitizeNote(" a\u0000b <b>c</b> `d` ")).toBe("a b bc/b d");
    expect(sanitizeNote("x".repeat(900)).length).toBe(500);
  });
});
