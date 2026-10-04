import type { Llm } from "../server/llm/types";

const MERCHANTS = ["Super Ahorro", "Boutique Moda", "Moto Rápida", "Mercado Central", "Farmacia Salud"];

/**
 * Scripted model for offline harness runs (CI, no API key). Slot extraction is a regex over the message; replies
 * are deliberately invalid so AIDO falls back to its deterministic templates. Not a model of Gemini: numbers from a
 * fake run check the harness only and are labeled as such in the report.
 */
export function fakeEvalLlm(): Llm {
  return {
    model: "fake-eval",
    async generate(req) {
      if (!req.system.startsWith("You extract")) return { text: "{}", model: "fake-eval", inputTokens: 0, outputTokens: 0 };
      const msg = (req.user.match(/<customer_message>([\s\S]*?)<\/customer_message>/)?.[1] ?? req.user).toLowerCase();
      const slots: Record<string, unknown> = {};
      const merchant = MERCHANTS.find((m) => msg.includes(m.toLowerCase()));
      if (merchant) slots.merchant = merchant;
      const amount = msg.match(/(\d+(?:[.,]\d+)?)\s*(?:dólares|dolares|usd|pesos|reais)/);
      if (amount) slots.amount = Number(amount[1]!.replace(",", "."));
      if (/reconozco|reconheço|disputar|contestar|no fui|não fui/.test(msg)) slots.reason = "unrecognized";
      return { text: JSON.stringify(slots), model: "fake-eval", inputTokens: 0, outputTokens: 0 };
    },
  };
}
