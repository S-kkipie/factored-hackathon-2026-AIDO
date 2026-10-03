import { describe, expect, test } from "bun:test";
import { openServing } from "../../server/db/serving";
import { factsFrom } from "../../server/graph/facts";
import { responseGate } from "../../server/gates/response";
import { type TemplateId, render, renderFacts } from "../../server/policy/templates";
import { val } from "../../server/provenance";
import type { Dispute } from "../../server/tools";
import { FIXTURE, makeDb } from "./fixtures";

const serving = openServing(await makeDb());
const txs = (await serving.transactions(FIXTURE.normal));
const products = (await serving.products(FIXTURE.normal));
const dispute: Dispute = {
  dispute_id: "D-ABCDEF123456",
  customer_id: FIXTURE.normal,
  transaction_ids: [FIXTURE.txSmall],
  reason: "unrecognized",
  amount_usd: 45,
  status: "received",
  created_at: "2026-10-03T00:00:00Z",
  customer_note: null,
};

const IDS: TemplateId[] = [
  "greeting", "clarify_intent", "clarify_target", "no_match", "abstain", "handoff", "handoff_failed", "handed_off",
  "confirm_dispute", "dispute_created", "dispute_cancelled", "confirmation_invalid", "budget_exhausted",
  "blocked_input", "no_results",
];

describe("templates", () => {
  test.each(["es", "pt"] as const)("every %s template passes the response gate with its own facts", async (lang) => {
    for (const id of IDS) {
      const text = render(id, lang, { transactions: txs.slice(0, 2), dispute, handoffId: "H-0123456789AB", reason: "incorrect_amount" });
      const facts = factsFrom(
        { transactions: val(txs, "db"), dispute: val(dispute, "db"), handoffId: val("H-0123456789AB", "db") },
        [text],
      );
      const check = responseGate(text, facts, { language: lang, canary: "cnry-x" });
      expect({ id, ruleIds: check.ruleIds }).toEqual({ id, ruleIds: [] });
    }
  });

  test("dispute_created quotes the policy timeline and the case id", async () => {
    expect(render("dispute_created", "es", { dispute })).toContain("D-ABCDEF123456");
    expect(render("dispute_created", "pt", { dispute })).toContain("10 dias úteis");
  });

  test("confirm_dispute names the reason the confirmation nonce is bound to", async () => {
    expect(render("confirm_dispute", "es", { transactions: txs.slice(0, 1), reason: "unrecognized" })).toContain("cargo no reconocido");
    expect(render("confirm_dispute", "es", { transactions: txs.slice(0, 1), reason: "incorrect_amount" })).toContain("monto incorrecto");
    expect(render("confirm_dispute", "es", { transactions: txs.slice(0, 1), reason: "duplicate" })).toContain("cargo duplicado");
    expect(render("confirm_dispute", "pt", { transactions: txs.slice(0, 1), reason: "unrecognized" })).toContain("cobrança não reconhecida");
    expect(render("confirm_dispute", "pt", { transactions: txs.slice(0, 1), reason: "incorrect_amount" })).toContain("valor incorreto");
    expect(render("confirm_dispute", "pt", { transactions: txs.slice(0, 1), reason: "duplicate" })).toContain("cobrança duplicada");
  });

  test("renderFacts output is grounded without templates", async () => {
    for (const lang of ["es", "pt"] as const) {
      const text = renderFacts(lang, { products, transactions: txs });
      const facts = factsFrom({ products: val(products, "db"), transactions: val(txs, "db") }, []);
      expect(responseGate(text, facts, { language: lang, canary: "cnry-x" }).ruleIds).toEqual([]);
    }
  });
});

describe("factsFrom", () => {
  test("collects ids and amounts in fact currency and USD", async () => {
    const f = factsFrom({ transactions: val(txs.slice(0, 1), "db"), products: val(products, "db") }, ["t"]);
    expect(f.ids).toContain(txs[0]!.transaction_id);
    expect(f.ids).toContain("PRD-A1");
    expect(f.amounts).toContainEqual({ value: 1200.5, currency: "USD" });
    expect(f.amounts).toContainEqual({ value: 5000 - 1200.5, currency: "USD" });
    expect(f.templates).toEqual(["t"]);
  });

  test("rejects values that did not come from the database", async () => {
    expect(() => factsFrom({ transactions: val(txs, "llm") }, [])).toThrow("PROV_001");
    expect(() => factsFrom({ handoffId: val("H-1", "user") }, [])).toThrow("PROV_001");
  });
});
