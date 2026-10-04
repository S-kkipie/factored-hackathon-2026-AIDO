import { describe, expect, test } from "bun:test";
import { SCENARIO_LANGS } from "../../eval/scenario";
import { FAMILIES, dateWords, fill, monthWord } from "../../eval/templates";

describe("scenario families", () => {
  test("ids are unique and per-language counts follow the spec 7 shares (100 per language)", () => {
    expect(new Set(FAMILIES.map((f) => f.id)).size).toBe(FAMILIES.length);
    const by = (c: string) => FAMILIES.filter((f) => f.category === c).reduce((s, f) => s + f.perLanguage, 0);
    expect({
      normal: by("normal"),
      ambiguous: by("ambiguous"),
      out_of_scope: by("out_of_scope"),
      escalate: by("escalate"),
      adversarial: by("adversarial"),
      failure: by("failure"),
      multilingual: by("multilingual"),
    }).toEqual({ normal: 35, ambiguous: 15, out_of_scope: 10, escalate: 15, adversarial: 10, failure: 10, multilingual: 5 });
  });

  test("every family builds in both languages with no unfilled placeholders", () => {
    const tx = {
      transaction_id: "TRX-ABCDEF123456", transaction_date: "2026-06-10T12:00:00", product_id: "PRD-1", customer_id: "CLI-1",
      transaction_type: "Purchase", transaction_category: null, amount: 45, currency: "USD", amount_usd: 45, channel: "POS",
      merchant_name: "Super Ahorro", merchant_category: null, transaction_country: "México", transaction_city: null,
      transaction_status: "Approved", response_code: null, fraud_score: 1,
    };
    const pick = { key: "k", customerId: "CLI-1", tx, other: { ...tx, transaction_id: "TRX-OTHER0000001", customer_id: "CLI-2" }, month: "2026-06", monthTxIds: ["TRX-ABCDEF123456"], balances: [10] };
    for (const f of FAMILIES)
      for (const lang of SCENARIO_LANGS)
        for (let index = 0; index < 3; index++) {
          const built = f.build({ lang, pick, index });
          expect(built.gold.outcomes.length).toBeGreaterThan(0);
          for (const turn of built.turns) if ("say" in turn) expect(turn.say).not.toMatch(/[{}]/);
        }
  });

  test("date and month words", () => {
    expect(dateWords("2026-06-10T12:00:00", "es")).toBe("10 de junio");
    expect(dateWords("2026-03-05", "pt")).toBe("5 de março");
    expect(monthWord("2026-05", "pt")).toBe("maio");
    expect(fill("{merchant} {amount}", { lang: "es", index: 0, pick: { key: "k", customerId: "c" } })).toBe(" ");
  });
});
