import { describe, expect, test } from "bun:test";
import type { Transaction } from "../../server/db/serving";
import { openServing } from "../../server/db/serving";
import { type PolicyInput, decide } from "../../server/policy/rules";
import { type Source, val } from "../../server/provenance";
import { FIXTURE, makeServing } from "./fixtures";

const serving = openServing(makeServing());
const customer = serving.customer(FIXTURE.normal)!;
const raw = (id: string) => serving.transaction(FIXTURE.normal, id)!;
const tx = (id: string) => val(raw(id), "db");
const txWith = (over: Partial<Transaction>, src: Source = "db") => val({ ...raw(FIXTURE.txSmall), ...over }, src);

const base = (over: Partial<PolicyInput>): PolicyInput => ({
  intent: "dispute_charge",
  customer,
  targets: [],
  disputedTransactionIds: [],
  repeatComplainer: false,
  riskScore: 0,
  ...over,
});

describe("decide", () => {
  test.each([
    ["read intent is allowed", base({ intent: "list_transactions" }), "allow", ["POL_READ"]],
    ["out of scope is denied", base({ intent: "out_of_scope" }), "deny", ["POL_SCOPE"]],
    ["explicit human request escalates", base({ intent: "request_human" }), "escalate", ["POL_HUMAN"]],
    ["dispute without target asks to clarify", base({}), "clarify", ["POL_DSP_NO_TARGET"]],
    ["small approved recent dispute needs confirmation", base({ targets: [tx(FIXTURE.txSmall)] }), "confirm", ["POL_DSP_OK"]],
    ["large amount escalates", base({ targets: [tx(FIXTURE.txLarge)] }), "escalate", ["POL_DSP_AMOUNT"]],
    ["fraud score escalates", base({ targets: [tx(FIXTURE.txFraud)] }), "escalate", ["POL_DSP_FRAUD"]],
    ["pending transaction escalates", base({ targets: [tx(FIXTURE.txPending)] }), "escalate", ["POL_DSP_STATUS"]],
    ["old transaction escalates", base({ targets: [tx(FIXTURE.txOld)] }), "escalate", ["POL_DSP_AGE"]],
    [
      "already disputed escalates",
      base({ targets: [tx(FIXTURE.txSmall)], disputedTransactionIds: [FIXTURE.txSmall] }),
      "escalate",
      ["POL_DSP_DUP"],
    ],
    ["repeat complainer escalates", base({ targets: [tx(FIXTURE.txSmall)], repeatComplainer: true }), "escalate", ["POL_REPEAT"]],
    ["high risk escalates", base({ intent: "check_balance", riskScore: 3 }), "escalate", ["POL_RISK"]],
  ] as const)("%s", (_, input, action, ruleIds) => {
    expect(decide(input)).toEqual({ action, ruleIds: [...ruleIds], policyVersion: "2026-10-02.1" });
  });

  test("accumulates every escalation reason", () => {
    const d = decide(base({ targets: [tx(FIXTURE.txLarge), tx(FIXTURE.txFraud), tx(FIXTURE.txSmall)] }));
    expect(d.action).toBe("escalate");
    expect(d.ruleIds).toEqual(["POL_DSP_AMOUNT", "POL_DSP_FRAUD", "POL_DSP_MANY"]);
  });

  test("suspended customers escalate even for reads", () => {
    const suspended = serving.customer(FIXTURE.suspended)!;
    expect(decide(base({ intent: "check_balance", customer: suspended }))).toMatchObject({
      action: "escalate",
      ruleIds: ["POL_STATUS"],
    });
  });
});

describe("decide boundaries and fail-closed inputs", () => {
  const one = (t: ReturnType<typeof txWith>) => decide(base({ targets: [t] }));

  test("amount_usd exactly 250 confirms; 250.01 escalates", () => {
    expect(one(txWith({ amount_usd: 250 }))).toMatchObject({ action: "confirm", ruleIds: ["POL_DSP_OK"] });
    expect(one(txWith({ amount_usd: 250.01 }))).toMatchObject({ action: "escalate", ruleIds: ["POL_DSP_AMOUNT"] });
  });

  test("fraud_score exactly 30 escalates; 29.99 confirms; null escalates", () => {
    expect(one(txWith({ fraud_score: 30 }))).toMatchObject({ action: "escalate", ruleIds: ["POL_DSP_FRAUD"] });
    expect(one(txWith({ fraud_score: 29.99 }))).toMatchObject({ action: "confirm", ruleIds: ["POL_DSP_OK"] });
    expect(one(txWith({ fraud_score: null }))).toMatchObject({ action: "escalate", ruleIds: ["POL_DSP_FRAUD"] });
  });

  test("any non-Active customer status escalates", () => {
    for (const status of ["Inactive", "Closed", "Suspended", "", "active"]) {
      expect(decide(base({ intent: "check_balance", customer: { ...customer, customer_status: status } }))).toMatchObject({
        action: "escalate",
        ruleIds: ["POL_STATUS"],
      });
    }
  });

  test("unparseable, future-dated and too-old transactions escalate on age", () => {
    expect(one(txWith({ transaction_date: "not a date" }))).toMatchObject({ ruleIds: ["POL_DSP_AGE"] });
    expect(one(txWith({ transaction_date: "2026-07-01T12:00:00" }))).toMatchObject({ ruleIds: ["POL_DSP_AGE"] });
    expect(one(txWith({ transaction_date: "2026-06-17T23:00:00" }))).toMatchObject({ action: "confirm" });
  });

  test("only Purchase, Withdrawal and Adjustment are auto-disputable", () => {
    for (const type of ["Purchase", "Withdrawal", "Adjustment"]) {
      expect(one(txWith({ transaction_type: type }))).toMatchObject({ action: "confirm" });
    }
    for (const type of ["Deposit", "Payment", "Transfer", ""]) {
      expect(one(txWith({ transaction_type: type }))).toMatchObject({ action: "escalate", ruleIds: ["POL_DSP_TYPE"] });
    }
  });

  test("duplicate targets are counted once", () => {
    const d = decide(base({ targets: [tx(FIXTURE.txSmall), tx(FIXTURE.txSmall), tx(FIXTURE.txSmall)] }));
    expect(d).toMatchObject({ action: "confirm", ruleIds: ["POL_DSP_OK"] });
  });

  test("NaN risk escalates", () => {
    expect(decide(base({ intent: "check_balance", riskScore: Number.NaN }))).toMatchObject({
      action: "escalate",
      ruleIds: ["POL_RISK"],
    });
  });

  test("targets not sourced from the database escalate with PROV_001", () => {
    for (const src of ["llm", "user", "jwt"] as const) {
      expect(decide(base({ targets: [txWith({}, src)] }))).toMatchObject({ action: "escalate", ruleIds: ["PROV_001"] });
    }
    expect(decide(base({ intent: "explain_charge", targets: [txWith({}, "llm")] }))).toMatchObject({
      action: "escalate",
      ruleIds: ["PROV_001"],
    });
  });

  test("cross-tier: gate tier short-circuits dispute checks", () => {
    const suspended = serving.customer(FIXTURE.suspended)!;
    expect(decide(base({ customer: suspended, targets: [tx(FIXTURE.txLarge)] }))).toEqual({
      action: "escalate",
      ruleIds: ["POL_STATUS"],
      policyVersion: "2026-10-02.1",
    });
  });
});
