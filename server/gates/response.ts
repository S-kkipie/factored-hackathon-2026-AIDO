import { maskPii } from "./pii";

export interface ResponseFacts {
  amounts: number[];
  ids: string[];
  /** Policy-rendered sentences (commitments) that may appear verbatim. */
  templates: string[];
}

export interface ResponseContext {
  language: "es" | "pt";
  canary: string;
}

export interface ResponseCheck {
  ok: boolean;
  ruleIds: string[];
}

const ID_PATTERN = /\b(?:CLI|PRD|TRX|CMP|D|H)-[A-Z0-9]{6,24}\b/g;
const CURRENCY = String.raw`(?:US\$|R\$|\$|USD|MXN|COP|ARS|BRL)`;
const WORDS = String.raw`(?:USD|MXN|COP|ARS|BRL|pesos|d[oó]lares|reais)`;
const NUMBER = String.raw`(\d[\d.,]*\d|\d)`;
const AMOUNT_PATTERN = new RegExp(String.raw`${CURRENCY}\s?${NUMBER}|${NUMBER}\s?${WORDS}`, "gi");
const COMMITMENT =
  /\b(reembols\w*|reintegr\w*|devolvemos|devolveremos|abonaremos|aprobad[oa]s?|aprobamos|garantiz\w*|estorn\w*|ressarc\w*|aprovad[oa]s?|aprovamos|garantim\w*)\b|\b(?:en|dentro de|em|até)\s+\d+\s+(?:d[ií]as|dias|horas)\b/i;
// Unicode-aware word boundaries: JavaScript's \b treats accented letters as non-word characters.
const ES_MARKERS = /(?<!\p{L})(?:el|los|las|usted|está|cuenta|cargo|puedo|gracias|sí|su|del)(?!\p{L})|ñ|¿|¡/giu;
const PT_MARKERS = /(?<!\p{L})(?:você|não|sua|seu|conta|cobrança|posso|obrigad[oa]|é|do|da)(?!\p{L})|ção|ções|ã|õ/giu;

/** Parses "1.234,56", "1,234.56", "45.00", "1.234" (thousands) into a number. */
export function parseAmount(raw: string): number {
  const lastDot = raw.lastIndexOf(".");
  const lastComma = raw.lastIndexOf(",");
  const decimalSep = lastDot > lastComma ? "." : ",";
  const decimalIdx = Math.max(lastDot, lastComma);
  const hasDecimal = decimalIdx >= 0 && raw.length - decimalIdx - 1 === 2;
  if (!hasDecimal) return Number(raw.replace(/[.,]/g, ""));
  const thousandsSep = decimalSep === "." ? "," : ".";
  return Number(raw.replaceAll(thousandsSep, "").replace(decimalSep, "."));
}

export function detectLanguage(text: string): "es" | "pt" | "unknown" {
  const es = text.match(ES_MARKERS)?.length ?? 0;
  const pt = text.match(PT_MARKERS)?.length ?? 0;
  if (es === pt) return "unknown";
  return es > pt ? "es" : "pt";
}

/** Gate 7: nothing reaches the customer unless every number and id is grounded and no commitment is improvised. */
export function responseGate(text: string, facts: ResponseFacts, ctx: ResponseContext): ResponseCheck {
  const rules = new Set<string>();
  if (text.includes(ctx.canary)) rules.add("RS_CANARY");
  if (maskPii(text).found.length > 0) rules.add("RS_PII");

  for (const id of text.match(ID_PATTERN) ?? []) {
    if (!facts.ids.includes(id)) rules.add("RS_ID");
  }

  for (const m of text.matchAll(AMOUNT_PATTERN)) {
    const raw = m[1] ?? m[2];
    if (!raw) continue;
    const amount = parseAmount(raw);
    if (!facts.amounts.some((a) => Math.abs(a - amount) <= 0.01)) rules.add("RS_AMOUNT");
  }

  const withoutTemplates = facts.templates.reduce((t, tpl) => t.replaceAll(tpl, " "), text);
  if (COMMITMENT.test(withoutTemplates)) rules.add("RS_COMMIT");

  const lang = detectLanguage(text);
  if (lang !== "unknown" && lang !== ctx.language) rules.add("RS_LANG");

  const ruleIds = [...rules].sort();
  return { ok: ruleIds.length === 0, ruleIds };
}
