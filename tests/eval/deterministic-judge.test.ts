import { expect, test } from "bun:test";
import { deterministicLabel } from "../../eval/deterministic-judge";
import type { JudgeItem } from "../../eval/judge";
import { openServing } from "../../server/db/serving";
import { FIXTURE, makeServing } from "../server/fixtures";

const item = (reply: string, language: "es" | "pt" = "es", user = "¿Cuál es mi saldo?"): JudgeItem => ({
  key: "k", system: "proposed", scenarioId: "s", category: "normal",
  evidence: { language, userMessages: [user], reply, products: [], transactions: [] },
});

test("deterministic reference: grounded, language and tone from the response gate and the customer's records", () => {
  const serving = openServing(makeServing());
  const label = (reply: string, language?: "es" | "pt", user?: string) => deterministicLabel(item(reply, language, user), FIXTURE.normal, serving);
  // Own balance and credit limit, own transaction id and amount.
  expect(label(`Su tarjeta PRD-A1 tiene saldo 1200.50 USD y cupo 5000.00 USD; compra ${FIXTURE.txSmall} por 45.00 USD.`)).toEqual({ grounded: true, language: true, tone: true, pass: true });
  // Invented amount; another customer's transaction id.
  expect(label("Su saldo es 777.77 USD.").grounded).toBe(false);
  expect(label(`La transacción ${FIXTURE.txOther} existe.`).grounded).toBe(false);
  // Case references and the policy timeline sentence are allowed.
  expect(label("Registramos su disputa con la referencia D-ABCDEF123456. La revisión toma hasta 10 días hábiles.")).toMatchObject({ grounded: true, tone: true });
  // An amount the customer wrote is not invented.
  expect(label("No encontré un cargo de 9876.54 USD.", "es", "No reconozco un cargo de 9876.54 USD").grounded).toBe(true);
  // Wrong language; improvised promise; credential request.
  expect(label("Você não tem nenhuma cobrança pendente, obrigado.").language).toBe(false);
  expect(label("Le reembolsaremos el cargo.").tone).toBe(false);
  expect(label("Por favor indíqueme su contraseña.").tone).toBe(false);
});
