import { describe, expect, test } from "bun:test";
import { openServing } from "../../server/db/serving";
import { ProvenanceError, val } from "../../server/provenance";
import { createTools, sanitizeNote } from "../../server/tools";
import { ToolError, runTool } from "../../server/tools/runtime";
import { FIXTURE, makeOps, makeServing } from "./fixtures";

const me = val(FIXTURE.normal, "jwt");

function setup() {
  const ops = makeOps();
  return { ops, tools: createTools(openServing(makeServing()), ops) };
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
  test("reads are scoped to the session customer and tagged db", () => {
    const { tools } = setup();
    expect(tools.getTransaction(me, val(FIXTURE.txSmall, "llm"))).toMatchObject({ src: "db", v: { amount_usd: 45 } });
    expect(() => tools.getTransaction(me, val(FIXTURE.txOther, "user"))).toThrow(ToolError);
    expect(tools.searchTransactions(me, { merchant: "uber" }).v.map((t) => t.transaction_id)).toEqual([FIXTURE.txFraud]);
  });

  test("rejects identity values that did not come from the JWT", () => {
    const { tools } = setup();
    expect(() => tools.getAccounts(val(FIXTURE.normal, "llm"))).toThrow(ProvenanceError);
    expect(() => tools.searchTransactions(val(FIXTURE.repeat, "user"), {})).toThrow("PROV_001");
  });

  test("createDispute requires db-sourced transactions owned by the customer and is idempotent", () => {
    const { tools, ops } = setup();
    const tx = tools.getTransaction(me, val(FIXTURE.txSmall, "user"));
    const input = {
      sessionId: "s1",
      customerId: me,
      transactions: [tx],
      reason: "unrecognized" as const,
      customerNote: val("No reconozco <script>alert(1)</script> este cargo\u0007", "user" as const),
      idempotencyKey: "s1:int-1",
    };
    const first = tools.createDispute(input);
    const second = tools.createDispute(input);
    expect(first.v.dispute_id).toMatch(/^D-[0-9A-F]{8}$/);
    expect(second.v.dispute_id).toBe(first.v.dispute_id);
    expect(first.v).toMatchObject({ amount_usd: 45, status: "received", transaction_ids: [FIXTURE.txSmall] });
    expect(first.v.customer_note).toBe("No reconozco scriptalert(1)/script este cargo");
    expect(ops.query<{ n: number }, []>("select count(*) as n from disputes").get()?.n).toBe(1);
    expect(ops.query<{ u: number }, []>("select note_untrusted as u from disputes").get()?.u).toBe(1);

    const forged = { ...input, idempotencyKey: "s1:int-2", transactions: [val(tx.v, "llm" as const)] };
    expect(() => tools.createDispute(forged)).toThrow("PROV_001");
  });

  test("createDispute refuses transactions of another customer even if db-sourced", () => {
    const { tools } = setup();
    const other = createTools(openServing(makeServing()), makeOps()).getTransaction(
      val(FIXTURE.repeat, "jwt"),
      val(FIXTURE.txOther, "user"),
    );
    expect(() =>
      tools.createDispute({
        sessionId: "s1",
        customerId: me,
        transactions: [other],
        reason: "unrecognized",
        customerNote: null,
        idempotencyKey: "k",
      }),
    ).toThrow("TL_OWNER");
  });

  test("getDispute is scoped and history includes created disputes", () => {
    const { tools } = setup();
    const tx = tools.getTransaction(me, val(FIXTURE.txSmall, "user"));
    const d = tools.createDispute({
      sessionId: "s1",
      customerId: me,
      transactions: [tx],
      reason: "duplicate",
      customerNote: null,
      idempotencyKey: "k1",
    });
    expect(tools.getDispute(me, d.v.dispute_id)?.v.dispute_id).toBe(d.v.dispute_id);
    expect(tools.getDispute(val(FIXTURE.repeat, "jwt"), d.v.dispute_id)).toBeNull();
    expect(tools.getDisputeHistory(me).v.disputedTransactionIds).toEqual([FIXTURE.txSmall]);
    expect(tools.getDisputeHistory(val(FIXTURE.repeat, "jwt")).v.repeatComplainer).toBe(true);
  });

  test("createHandoff stores a structured card", () => {
    const { tools, ops } = setup();
    const h = tools.createHandoff({
      sessionId: "s1",
      customerId: me,
      ruleIds: ["POL_DSP_AMOUNT"],
      card: {
        summary: "Disputa de cargo alto",
        verifiedFacts: [{ kind: "transaction", id: FIXTURE.txLarge, detail: "USD 700 Boutique Moda" }],
        actionsTaken: [],
        ruleIds: ["POL_DSP_AMOUNT"],
        openQuestions: ["¿Reconoce el comercio?"],
        language: "es",
      },
    });
    expect(h.v.handoffId).toMatch(/^H-/);
    expect(ops.query<{ status: string }, []>("select status from handoffs").get()?.status).toBe("queued");
  });

  test("sanitizeNote strips control characters and markup, caps length", () => {
    expect(sanitizeNote(" a\u0000b <b>c</b> `d` ")).toBe("a b bc/b d");
    expect(sanitizeNote("x".repeat(900)).length).toBe(500);
  });
});
