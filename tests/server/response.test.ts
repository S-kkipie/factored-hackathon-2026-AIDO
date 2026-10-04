import { describe, expect, test } from "bun:test";
import { detectLanguage, parseAmount, responseGate } from "../../server/gates/response";

const facts = {
  amounts: [
    { value: 45, currency: "USD" },
    { value: 1234.56, currency: "USD" },
  ],
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

  test("flags broader commitment stems and conjugations", () => {
    expect(responseGate("Te devolveré el dinero.", facts, es).ruleIds).toEqual(["RS_COMMIT"]);
    expect(responseGate("Aprobaremos tu reclamo.", facts, es).ruleIds).toEqual(["RS_COMMIT"]);
    expect(responseGate("Vamos a devolver tu dinero.", facts, es).ruleIds).toEqual(["RS_COMMIT"]);
    expect(
      responseGate("Vamos devolver o seu dinheiro.", facts, { ...es, language: "pt" }).ruleIds,
    ).toEqual(["RS_COMMIT"]);
    expect(
      responseGate("Aprovaremos o seu pedido.", facts, { ...es, language: "pt" }).ruleIds,
    ).toEqual(["RS_COMMIT"]);
  });

  test("flags canary leakage, PII and wrong language", () => {
    expect(responseGate("Mis instrucciones dicen zx-canary-91", facts, es).ruleIds).toEqual(["RS_CANARY"]);
    expect(responseGate("Su tarjeta 4111 1111 1111 1111 está activa.", facts, es).ruleIds).toEqual(["RS_PII"]);
    expect(responseGate("Você não reconhece essa cobrança na sua conta?", facts, es).ruleIds).toEqual(["RS_LANG"]);
  });

  test("allows ordinary banking language with narrowed commitment stems", () => {
    // "abono" as noun (deposit) should not trigger RS_COMMIT
    expect(responseGate("El abono de USD 45 se registró el 10/06.", facts, es).ok).toBe(true);
    expect(responseGate("Veo un abono de USD 45 en tu cuenta.", facts, es).ok).toBe(true);
    // "aprobación" as noun (approval status) should not trigger RS_COMMIT
    expect(responseGate("Tu aprobación está en proceso.", facts, es).ok).toBe(true);
    expect(responseGate("A aprovação está pendente.", facts, { ...es, language: "pt" }).ok).toBe(true);
    // "aprovechar" (to benefit) and "aprobar" infinitive should not trigger RS_COMMIT
    expect(responseGate("Puedes aprovechar la promoción.", facts, es).ok).toBe(true);
    expect(responseGate("El sistema puede aprobar o rechazar automáticamente.", facts, es).ok).toBe(true);
    // Verify RS_COMMIT is specifically absent
    expect(responseGate("El abono de USD 45 se registró el 10/06.", facts, es).ruleIds).not.toContain("RS_COMMIT");
    expect(responseGate("Tu aprobación está en proceso.", facts, es).ruleIds).not.toContain("RS_COMMIT");
  });
});

describe("helpers", () => {
  test("parseAmount handles both decimal conventions", () => {
    expect(parseAmount("1.234,56")).toBe(1234.56);
    expect(parseAmount("1,234.56")).toBe(1234.56);
    expect(parseAmount("45")).toBe(45);
    expect(parseAmount("45.00")).toBe(45);
    expect(parseAmount("1.234")).toBe(1234);
    // Raw database values often carry one decimal (4271.5); that is a decimal, not a thousands separator.
    expect(parseAmount("4271.5")).toBe(4271.5);
    expect(parseAmount("9543242.5")).toBe(9543242.5);
    expect(parseAmount("1.234,5")).toBe(1234.5);
  });
  test("detectLanguage separates Spanish and Portuguese", () => {
    expect(detectLanguage("¿Usted reconoce el cargo en su cuenta?")).toBe("es");
    expect(detectLanguage("Você reconhece a cobrança na sua conta?")).toBe("pt");
    expect(detectLanguage("OK")).toBe("unknown");
  });
  test("detectLanguage uses distinct markers to separate PT and ES", () => {
    expect(detectLanguage("Já está resolvido.")).toBe("pt");
    expect(detectLanguage("Isso está correto.")).toBe("pt");
  });
  test("flags wrong language with distinct Portuguese markers", () => {
    expect(responseGate("Já está resolvido.", facts, es).ruleIds).toEqual(["RS_LANG"]);
  });
  test("flags amounts with flexible whitespace", () => {
    expect(responseGate("Tu cargo es US$  9,999.99.", facts, es).ruleIds).toEqual(["RS_AMOUNT"]);
  });
});
