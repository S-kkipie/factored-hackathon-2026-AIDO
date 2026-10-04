import { describe, expect, test } from "bun:test";
import { CORPUS } from "../../eval/redteam/corpus";
import { SCENARIO_LANGS } from "../../eval/scenario";

describe("red-team corpus", () => {
  test("19 attacks and 10 benign items per language, every attack tagged", () => {
    const attacks = CORPUS.filter((f) => f.attackClass);
    const benign = CORPUS.filter((f) => !f.attackClass);
    expect(attacks.reduce((s, f) => s + f.perLanguage, 0)).toBe(19);
    expect(benign.reduce((s, f) => s + f.perLanguage, 0)).toBe(10);
    for (const f of attacks) expect(f.owasp?.length).toBeGreaterThan(0);
  });

  test("every family builds in both languages without placeholders; attacks never allow a dispute", () => {
    const tx = { transaction_id: "TRX-ABCDEF123456", transaction_date: "2026-06-10T12:00:00", product_id: "PRD-1", customer_id: "CLI-1",
      transaction_type: "Purchase", transaction_category: null, amount: 45, currency: "USD", amount_usd: 45, channel: "POS",
      merchant_name: "Panadería Sol", merchant_category: null, transaction_country: "México", transaction_city: null,
      transaction_status: "Approved", response_code: null, fraud_score: 1 };
    const pick = { key: "k", customerId: "CLI-1", tx, other: { ...tx, transaction_id: "TRX-OTHER0000001", customer_id: "CLI-2" }, month: "2026-06", monthTxIds: [tx.transaction_id], balances: [10] };
    for (const f of CORPUS)
      for (const lang of SCENARIO_LANGS) {
        const b = f.build({ lang, pick, index: 0 });
        for (const t of b.turns) if ("say" in t) expect(t.say).not.toMatch(/[{}]/);
        if (f.attackClass) expect(b.gold.disputeTxIds).toBeNull();
      }
  });

  test("the typed-confirmation attack has no button turn", () => {
    const f = CORPUS.find((x) => x.id === "atk_typed_confirm")!;
    const b = f.build({ lang: "es", index: 0, pick: { key: "k", customerId: "c", tx: { transaction_id: "TRX-ABCDEF123456", transaction_date: "2026-06-10", merchant_name: "X", amount: 1, currency: "USD" } as never } });
    expect(b.turns.every((t) => "say" in t)).toBe(true);
    expect(b.turns.length).toBe(2);
  });
});
