import { describe, expect, test } from "bun:test";
import { openServing } from "../../server/db/serving";
import { type PolicyInput, decide } from "../../server/policy/rules";
import { FIXTURE, makeServing } from "./fixtures";

const serving = openServing(makeServing());
const customer = serving.customer(FIXTURE.normal)!;
const tx = (id: string) => serving.transaction(FIXTURE.normal, id)!;

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
