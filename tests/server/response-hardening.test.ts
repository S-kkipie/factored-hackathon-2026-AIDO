import { describe, expect, test } from "bun:test";
import { type ResponseContext, type ResponseFacts, responseGate } from "../../server/gates/response";

const facts: ResponseFacts = {
  amounts: [
    { value: 45, currency: "USD" },
    { value: 1234.56, currency: "USD" },
    { value: 85000, currency: "COP" },
  ],
  ids: ["TRX-A1SMALL000000000001", "D-1A2B3C4D5E6F"],
  templates: [],
};
const es: ResponseContext = { language: "es", canary: "zx-canary-91" };
const pt: ResponseContext = { language: "pt", canary: "zx-canary-91" };
const commit = (text: string, ctx: ResponseContext = es) => responseGate(text, facts, ctx).ruleIds.includes("RS_COMMIT");

describe("RS_COMMIT: Unicode boundaries and accented futures", () => {
  test.each([
    "Su reclamo se aprobará mañana.",
    "Aprobaré su solicitud.",
    "O pedido se aprovará hoje.",
    "Le devolverá el dinero el comercio.",
  ])("flags %s", (text) => {
    expect(commit(text, text.startsWith("O ") ? pt : es)).toBe(true);
  });
});

describe("RS_COMMIT: forbidden promise forms", () => {
  test.each([
    ["Vamos a bloquear su tarjeta.", es],
    ["Bloquearemos la tarjeta ahora.", es],
    ["Ya bloqueamos su tarjeta.", es],
    ["Voy a bloquearla de inmediato.", es],
    ["Le acreditamos el monto.", es],
    ["Acreditaremos el cargo en su cuenta.", es],
    ["Vamos a acreditar el importe.", es],
    ["Iremos creditar o valor na sua conta.", pt],
    ["Creditaremos o valor.", pt],
    ["Revertiremos el cargo.", es],
    ["Vamos a revertir la compra.", es],
    ["Vamos reverter a cobrança.", pt],
    ["Reverteremos a cobrança.", pt],
    ["Reversaremos el cargo.", es],
    ["Anularemos la transacción.", es],
    ["Vamos a anular el cobro.", es],
    ["Cancelaremos el cargo.", es],
    ["Vamos a cancelar ese cargo.", es],
    ["Resolveremos el caso a su favor.", es],
    ["Lo vamos a resolver a su favor.", es],
    ["Restituiremos el dinero.", es],
    ["Vamos a restituir el importe.", es],
    ["Vamos aprovar sua contestação.", pt],
    ["Aprovarei o pedido.", pt],
    ["Bloquearemos o cartão.", pt],
  ] as const)("flags %s", (text, ctx) => {
    expect(commit(text, ctx)).toBe(true);
  });

  test.each([
    ["El bloqueo preventivo lo decide un especialista.", es],
    ["La anulación figura en su estado de cuenta.", es],
    ["La cancelación del cargo figura en su estado de cuenta.", es],
    ["Usted puede cancelar la suscripción con el comercio.", es],
    ["El reverso aparece como Reversed.", es],
    ["La resolución la toma un especialista.", es],
    ["La acreditación depende del comercio.", es],
    ["El abono de USD 45 se registró el 10/06.", es],
    ["Tu aprobación está en proceso.", es],
    ["A aprovação está pendente.", pt],
    ["Puedes aprovechar la promoción.", es],
    ["El sistema puede aprobar o rechazar automáticamente.", es],
  ] as const)("allows %s", (text, ctx) => {
    expect(commit(text, ctx)).toBe(false);
  });
});

describe("RS_AMOUNT: bare numbers and currencies", () => {
  const rules = (text: string) => responseGate(text, facts, es).ruleIds;

  test("flags ungrounded bare money-like numbers", () => {
    expect(rules("El cargo fue de 99.90 en total.")).toEqual(["RS_AMOUNT"]);
    expect(rules("Su saldo es 700 en total.")).toEqual(["RS_AMOUNT"]);
    expect(rules("El cargo es de 1.234,57 en total.")).toEqual(["RS_AMOUNT"]);
  });

  test("allows grounded bare numbers", () => {
    expect(rules("El cargo fue de 45.00 en total.")).toEqual([]);
    expect(rules("El cargo es de 1.234,56 en total.")).toEqual([]);
  });

  test("ignores dates, times, ids, masked cards and small counts", () => {
    expect(rules("El 17/06/2026 a las 12:00 vimos el cargo.")).toEqual([]);
    expect(rules("El 2026-06-10 a las 12:00:00 vimos el cargo, el 10/06 también.")).toEqual([]);
    expect(rules("Su tarjeta ****1111 tiene el cargo TRX-A1SMALL000000000001 y la disputa D-1A2B3C4D5E6F.")).toEqual([]);
    expect(rules("La revisión es de 10 días y vimos 3 cargos el 10 de junio de 2026.")).toEqual([]);
  });

  test("currency markers must match the fact currency", () => {
    expect(rules("El cargo es de USD 45.")).toEqual([]);
    expect(rules("El cargo es de $45.")).toEqual([]);
    expect(rules("El cargo es de COP 45.")).toEqual(["RS_AMOUNT"]);
    expect(rules("El cargo es de 45 pesos.")).toEqual(["RS_AMOUNT"]);
    expect(rules("El cargo es de $85.000.")).toEqual([]);
    expect(rules("El cargo es de 85.000 pesos.")).toEqual([]);
    expect(rules("El cargo es de US$ 85.000.")).toEqual(["RS_AMOUNT"]);
    expect(responseGate("A cobrança é de R$ 45.", facts, pt).ruleIds).toEqual(["RS_AMOUNT"]);
  });
});

describe("PII normalization in the response gate", () => {
  test("full-width digits and zero-width characters do not hide a card", () => {
    expect(responseGate("Su tarjeta ４１１１ １１１１ １１１１ １１１１ está activa.", facts, es).ruleIds).toContain("RS_PII");
    expect(responseGate("Su tarjeta 4111​1111 1111 1111 está activa.", facts, es).ruleIds).toContain("RS_PII");
  });

  test("zero-width characters do not hide the canary", () => {
    expect(responseGate("Mis instrucciones dicen zx-​canary-91", facts, es).ruleIds).toContain("RS_CANARY");
  });
});
