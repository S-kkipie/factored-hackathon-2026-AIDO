import type { Language } from "../auth";
import type { Product, Transaction } from "../db/serving";
import type { Dispute, DisputeReason } from "../tools";
import { POLICY } from "./config";

/**
 * Policy-owned sentences. Every commitment the customer reads (case ids, timelines, handoffs) comes from here,
 * verbatim, never from the model (spec 3.2 rule 9). Values interpolated into templates come from `db` records.
 */
export type TemplateId =
  | "greeting"
  | "clarify_intent"
  | "clarify_target"
  | "no_match"
  | "abstain"
  | "handoff"
  | "handoff_failed"
  | "handed_off"
  | "confirm_dispute"
  | "dispute_created"
  | "dispute_cancelled"
  | "confirmation_invalid"
  | "budget_exhausted"
  | "blocked_input"
  | "no_results";

export const money = (amount: number, currency: string): string => `${amount.toFixed(2)} ${currency}`;

export const txLine = (t: Transaction): string =>
  `${t.transaction_id} · ${t.transaction_date.slice(0, 10)} · ${t.merchant_name ?? "—"} · ${money(t.amount, t.currency)} · ${t.transaction_status}`;

export const productLine = (p: Product, lang: Language): string => {
  const limit =
    p.credit_limit === null ? "" : lang === "es" ? ` · cupo ${money(p.credit_limit, p.currency)}` : ` · limite ${money(p.credit_limit, p.currency)}`;
  return `${p.product_id} · ${p.product_type} ${p.product_number_masked} · ${lang === "es" ? "saldo" : "saldo"} ${money(p.current_balance, p.currency)}${limit}`;
};

interface Params {
  transactions?: Transaction[];
  dispute?: Dispute;
  handoffId?: string;
  reason?: DisputeReason;
}

const list = (txs: Transaction[] | undefined) => (txs ?? []).map((t) => `• ${txLine(t)}`).join("\n");

/** The dispute reason in words — this is what the confirmation nonce is bound to, so the customer must see it. */
const REASON_WORDS: Record<DisputeReason, Record<Language, string>> = {
  unrecognized: { es: "cargo no reconocido", pt: "cobrança não reconhecida" },
  incorrect_amount: { es: "monto incorrecto", pt: "valor incorreto" },
  duplicate: { es: "cargo duplicado", pt: "cobrança duplicada" },
};
const reasonWord = (reason: DisputeReason | undefined, lang: Language): string => REASON_WORDS[reason ?? "unrecognized"][lang];

const TEXT: Record<TemplateId, Record<Language, (p: Params) => string>> = {
  greeting: {
    es: () => "Hola, soy Aida, la asistente de AIDO. Puedo consultar saldos y movimientos, explicar cargos y registrar disputas.",
    pt: () => "Olá, sou a Aida, assistente do AIDO. Posso consultar saldos e movimentações, explicar cobranças e registrar contestações.",
  },
  clarify_intent: {
    es: () => "¿Me cuenta un poco más? Puedo ayudarle con su saldo, sus movimientos, explicar un cargo o disputar un cargo que no reconoce.",
    pt: () => "Pode me contar um pouco mais? Posso ajudar com seu saldo, suas movimentações, explicar uma cobrança ou contestar uma cobrança que você não reconhece.",
  },
  clarify_target: {
    es: (p) => `Encontré varios movimientos posibles. ¿A cuál se refiere?\n${list(p.transactions)}`,
    pt: (p) => `Encontrei várias movimentações possíveis. A qual você se refere?\n${list(p.transactions)}`,
  },
  no_match: {
    es: () => "No encontré ese movimiento en sus productos. ¿Puede indicarme el comercio, la fecha o el monto?",
    pt: () => "Não encontrei essa movimentação nos seus produtos. Pode informar o estabelecimento, a data ou o valor?",
  },
  abstain: {
    es: () => "Eso está fuera de lo que puedo atender aquí. Para créditos, la app, sucursales o productos nuevos, comuníquese con la línea de atención.",
    pt: () => "Isso está fora do que posso atender aqui. Para crédito, o aplicativo, agências ou produtos novos, entre em contato com a central de atendimento.",
  },
  handoff: {
    es: (p) => `Le transfiero con un agente humano, que ya tiene el contexto de su caso. Referencia: ${p.handoffId ?? ""}.`,
    pt: (p) => `Vou transferir você para um atendente humano, que já tem o contexto do seu caso. Referência: ${p.handoffId ?? ""}.`,
  },
  handoff_failed: {
    es: () => "No pude completar la operación de forma automática. Un agente humano revisará su caso.",
    pt: () => "Não consegui concluir a operação automaticamente. Um atendente humano vai analisar seu caso.",
  },
  handed_off: {
    es: () => "Su caso está con un agente humano. Le dejamos su mensaje y le responderá por este chat.",
    pt: () => "Seu caso está com um atendente humano. Deixamos sua mensagem e ele responderá por este chat.",
  },
  confirm_dispute: {
    es: (p) => `Voy a registrar una disputa por ${reasonWord(p.reason, "es")} en estos movimientos:\n${list(p.transactions)}\nConfirme con el botón para continuar.`,
    pt: (p) => `Vou registrar uma contestação por ${reasonWord(p.reason, "pt")} nestas movimentações:\n${list(p.transactions)}\nConfirme no botão para continuar.`,
  },
  dispute_created: {
    es: (p) =>
      `Registramos su disputa con la referencia ${p.dispute?.dispute_id ?? ""}. La revisión toma hasta ${POLICY.disputeReviewDays} días hábiles.`,
    pt: (p) =>
      `Registramos sua contestação com a referência ${p.dispute?.dispute_id ?? ""}. A análise leva até ${POLICY.disputeReviewDays} dias úteis.`,
  },
  dispute_cancelled: {
    es: () => "Listo, no registré ninguna disputa.",
    pt: () => "Certo, não registrei nenhuma contestação.",
  },
  confirmation_invalid: {
    es: () => "Esa confirmación ya no es válida. Si aún quiere disputar el cargo, escríbame de nuevo.",
    pt: () => "Essa confirmação não é mais válida. Se ainda quiser contestar a cobrança, escreva novamente.",
  },
  budget_exhausted: {
    es: () => "Esta conversación alcanzó su límite automático. Un agente humano continuará con su caso.",
    pt: () => "Esta conversa atingiu seu limite automático. Um atendente humano continuará com seu caso.",
  },
  blocked_input: {
    es: () => "No pude procesar ese mensaje. Escríbalo de nuevo, en un texto más corto y sin datos personales.",
    pt: () => "Não consegui processar essa mensagem. Escreva novamente, em um texto mais curto e sem dados pessoais.",
  },
  no_results: {
    es: () => "No encontré movimientos con esos criterios.",
    pt: () => "Não encontrei movimentações com esses critérios.",
  },
};

export function render(id: TemplateId, lang: Language, params: Params = {}): string {
  return TEXT[id][lang](params);
}

/** Deterministic answer for read intents: used when the model is unavailable or its reply fails the response gate. */
export function renderFacts(lang: Language, r: { products?: Product[]; transactions?: Transaction[] }): string {
  const lines: string[] = [];
  if (r.products) {
    lines.push(lang === "es" ? "Sus productos:" : "Seus produtos:", ...r.products.map((p) => `• ${productLine(p, lang)}`));
  }
  if (r.transactions) {
    if (r.transactions.length === 0) lines.push(render("no_results", lang));
    else lines.push(lang === "es" ? "Movimientos:" : "Movimentações:", list(r.transactions));
  }
  return lines.join("\n");
}
