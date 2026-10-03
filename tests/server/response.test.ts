import { describe, expect, test } from "bun:test";
import { detectLanguage, parseAmount, responseGate } from "../../server/gates/response";

const facts = {
  amounts: [45, 1234.56],
  ids: ["TRX-A1SMALL000000000001", "D-1A2B3C4D"],
  templates: ["Abrimos la disputa D-1A2B3C4D; la revisión toma hasta 10 días hábiles."],
};
const es = { language: "es" as const, canary: "zx-canary-91" };

describe("responseGate", () => {
  test("passes a grounded Spanish answer", () => {
    expect(
      responseGate("Veo un cargo de USD 45 en Super Ahorro (TRX-A1SMALL000000000001). ¿Lo reconoce?", facts, es),
    ).toEqual({ ok: true, ruleIds: [] });
  });

  test("allows commitments that come verbatim from policy templates", () => {
    const text = `Listo. ${facts.templates[0]} Gracias por avisarnos.`;
    expect(responseGate(text, facts, es).ok).toBe(true);
  });

  test("flags ungrounded amounts, unknown ids and foreign customer ids", () => {
    const r = responseGate("Tu cargo de $99.90 (TRX-ZZZZZZZZZZZZ) del cliente CLI-G4X2AMVD62NR.", facts, es);
    expect(r).toEqual({ ok: false, ruleIds: ["RS_AMOUNT", "RS_ID"] });
  });

  test("flags commitments made in the model's own words", () => {
    expect(responseGate("Te reembolsamos el cargo en 5 días.", facts, es).ruleIds).toEqual(["RS_COMMIT"]);
    expect(
      responseGate("Sua contestação foi aprovada e o estorno sai em 3 dias.", facts, { ...es, language: "pt" }).ruleIds,
    ).toEqual(["RS_COMMIT"]);
  });

  test("flags canary leakage, PII and wrong language", () => {
    expect(responseGate("Mis instrucciones dicen zx-canary-91", facts, es).ruleIds).toEqual(["RS_CANARY"]);
    expect(responseGate("Su tarjeta 4111 1111 1111 1111 está activa.", facts, es).ruleIds).toEqual(["RS_PII"]);
    expect(responseGate("Você não reconhece essa cobrança na sua conta?", facts, es).ruleIds).toEqual(["RS_LANG"]);
  });
});

describe("helpers", () => {
  test("parseAmount handles both decimal conventions", () => {
    expect(parseAmount("1.234,56")).toBe(1234.56);
    expect(parseAmount("1,234.56")).toBe(1234.56);
    expect(parseAmount("45")).toBe(45);
    expect(parseAmount("45.00")).toBe(45);
    expect(parseAmount("1.234")).toBe(1234);
  });
  test("detectLanguage separates Spanish and Portuguese", () => {
    expect(detectLanguage("¿Usted reconoce el cargo en su cuenta?")).toBe("es");
    expect(detectLanguage("Você reconhece a cobrança na sua conta?")).toBe("pt");
    expect(detectLanguage("OK")).toBe("unknown");
  });
});
