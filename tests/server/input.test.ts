import { describe, expect, test } from "bun:test";
import { inputGate } from "../../server/gates/input";
import { cpfValid, luhnValid, maskPii } from "../../server/gates/pii";
import { makeOps } from "./fixtures";

describe("maskPii", () => {
  test("masks valid card numbers only", () => {
    expect(maskPii("mi tarjeta 4111 1111 1111 1111").text).toBe("mi tarjeta [CARD]");
    expect(maskPii("número 4111 1111 1111 1112").found).toEqual([]);
  });
  test("masks CPF, CURP, ID documents, email and phone", () => {
    const r = maskPii(
      "CPF 529.982.247-25, CURP GODE561231HDFRRN09, DNI 30123456, ana@mail.com, +52 55 1234 5678",
    );
    expect(r.text).toBe("CPF [CPF], CURP [CURP], [ID_DOC], [EMAIL], [PHONE]");
    expect(r.found).toEqual(["email", "cpf", "curp", "id_doc", "phone"]);
  });
  test("leaves amounts and dates alone", () => {
    const text = "me cobraron $1.234,56 el 10/06/2026 y otro de 45.00 USD";
    expect(maskPii(text)).toEqual({ text, found: [] });
  });
  test("checksums", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(cpfValid("52998224725")).toBe(true);
    expect(cpfValid("11111111111")).toBe(false);
  });
  test("masks natural-language phrased ID documents", () => {
    const r1 = maskPii("mi cédula es 30123456");
    expect(r1.found).toContain("id_doc");
    expect(/\d/.test(r1.text)).toBe(false);
    const r2 = maskPii("meu RG é 12.345.678-9");
    expect(r2.found).toContain("id_doc");
    expect(/\d/.test(r2.text)).toBe(false);
  });
  test("masks dash-suffixed ID documents completely", () => {
    expect(maskPii("RG 12.345.678-9 es mi documento").text).toBe("[ID_DOC] es mi documento");
  });
  test("preserves email trailing punctuation", () => {
    expect(maskPii("Escribime a ana@mail.com. Gracias").text).toBe("Escribime a [EMAIL]. Gracias");
  });
  test("regression: non-PII numbers and transaction IDs are not masked", () => {
    expect(maskPii("me cobraron $1.234,56 el 10/06/2026 y otro de 45.00 USD").found).toEqual([]);
    expect(maskPii("el cargo TRX-A1SMALL000000000001 de 45 USD").found).toEqual([]);
  });
});

describe("inputGate", () => {
  const t0 = 1_000_000;
  test("rejects empty and oversized input", () => {
    const ops = makeOps();
    expect(inputGate(ops, "s1", "   ", t0)).toEqual({ ok: false, ruleId: "IN_EMPTY" });
    expect(inputGate(ops, "s1", "a".repeat(1001), t0)).toEqual({ ok: false, ruleId: "IN_SIZE" });
  });
  test("rate limits per session within a sliding minute", () => {
    const ops = makeOps();
    for (let i = 0; i < 12; i++) expect(inputGate(ops, "s1", "hola", t0 + i).ok).toBe(true);
    expect(inputGate(ops, "s1", "hola", t0 + 20)).toEqual({ ok: false, ruleId: "IN_RATE" });
    expect(inputGate(ops, "s2", "hola", t0 + 20).ok).toBe(true);
    expect(inputGate(ops, "s1", "hola", t0 + 61_000).ok).toBe(true);
  });
  test("returns masked text and the kinds found", () => {
    const r = inputGate(makeOps(), "s1", "mi correo es ana@mail.com", t0);
    expect(r).toEqual({ ok: true, text: "mi correo es [EMAIL]", piiFound: ["email"] });
  });
});
