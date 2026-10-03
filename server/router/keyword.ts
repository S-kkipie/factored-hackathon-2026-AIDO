import type { RouteLabel, RouteResult, Router } from "./types";

/** Lowercase, strip accents and collapse spaces so lexicons match "transacción", "transacao" and "TRANSAÇÃO". */
export const fold = (text: string): string =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

/** ES + PT cue phrases per label, written in folded form. Plan 3 compares this baseline against trained routers. */
const LEXICON: Record<Exclude<RouteLabel, "greeting">, RegExp> = {
  dispute_charge:
    /\b(no reconozco|desconozco|no hice|no fui yo|no autorice|disputa\w*|cobro indebido|cargo indebido|me cobraron (dos veces|de mas|doble)|cobrado (dos veces|duas vezes)|nao reconheco|desconheco|nao fiz|nao autorizei|contestar|contestacao|cobranca indevida|me cobraram|cobranca em dobro)\b/,
  explain_charge:
    /\b(que es (este|ese|el) (cargo|cobro|movimiento)|de que es|explica\w*|que significa|por que (me )?(aparece|cobraron)|o que e (essa|esta|a) (cobranca|transacao|compra)|explicar|explique|por que aparece)\b/,
  list_transactions:
    /\b(movimientos|transacciones|ultimas compras|mis compras|historial|extracto|estado de cuenta|transacoes|movimentacoes|extrato|minhas compras|ultimas transacoes|ultimos movimientos|ultimas operaciones)\b/,
  check_balance: /\b(saldo|disponible|cupo|cuanto tengo|cuanto debo|limite|quanto tenho|quanto devo|disponivel)\b/,
  request_human:
    /\b(agente|humano|una persona|asesor|ejecutivo|operador|atendente|uma pessoa|falar com alguem|hablar con alguien|gerente)\b/,
  out_of_scope:
    /\b(prestamo|credito hipotecario|hipoteca|sucursal|abrir (una )?cuenta|nueva tarjeta|inversion|seguro|la app|aplicacion|contrasena|emprestimo|financiamento|agencia|abrir (uma )?conta|cartao novo|investimento|aplicativo|senha)\b/,
};

const GREETING =
  /^(hola|buen(os|as) (dias|tardes|noches)|gracias|muchas gracias|ola|oi|bom dia|boa (tarde|noite)|obrigad[oa]|muito obrigad[oa])$/;

/** Keyword baseline router: unique match → 0.9, ties → 0.5 (clarify), nothing → 0 (clarify). */
export function createKeywordRouter(): Router {
  return {
    name: "keyword-v1",
    async route(text) {
      const t = fold(text);
      if (GREETING.test(t.replace(/[¡¿!?.,]+/g, " ").trim())) return { label: "greeting", confidence: 0.95, router: "keyword-v1" };
      const hits = (Object.keys(LEXICON) as (keyof typeof LEXICON)[]).filter((label) => LEXICON[label].test(t));
      const result = (label: RouteLabel, confidence: number): RouteResult => ({ label, confidence, router: "keyword-v1" });
      if (hits.length === 0) return result("out_of_scope", 0);
      // A dispute cue outranks an explanation or listing cue in the same message ("no reconozco este cargo").
      if (hits.includes("dispute_charge") && hits.every((h) => h === "dispute_charge" || h === "explain_charge" || h === "list_transactions")) {
        return result("dispute_charge", 0.9);
      }
      if (hits.length === 1) return result(hits[0]!, 0.9);
      return result(hits[0]!, 0.5);
    },
  };
}
