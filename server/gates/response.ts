import type { RuleIdWithPrefix } from "../rules";
import { maskPii, normalizeText } from "./pii";

export interface FactAmount {
  value: number;
  /** ISO currency of the fact (USD, MXN, COP, ARS, BRL). */
  currency: string;
}

export interface ResponseFacts {
  amounts: FactAmount[];
  ids: string[];
  /** Policy-rendered sentences (commitments) that may appear verbatim. */
  templates: string[];
}

export interface ResponseContext {
  language: "es" | "pt";
  canary: string;
}

export type ResponseRuleId = RuleIdWithPrefix<"RS">;

export interface ResponseCheck {
  ok: boolean;
  ruleIds: ResponseRuleId[];
}

const ID_PATTERN = /\b(?:CLI|PRD|TRX|CMP|D|H)-[A-Z0-9]{6,24}\b/g;

// ---- Amounts -------------------------------------------------------------------------------------------------

/** Which fact currencies a marker in the text can refer to. A bare `$` is ambiguous across dollar/peso currencies. */
const MARKER_CURRENCIES: [RegExp, string[]][] = [
  [/^(?:US\$|USD|d[oó]lar(?:es)?)$/i, ["USD"]],
  [/^(?:R\$|BRL|reais|real)$/i, ["BRL"]],
  [/^MXN$/i, ["MXN"]],
  [/^COP$/i, ["COP"]],
  [/^ARS$/i, ["ARS"]],
  [/^pesos?$/i, ["MXN", "COP", "ARS"]],
  [/^\$$/, ["USD", "MXN", "COP", "ARS"]],
];
const currenciesFor = (marker: string): string[] =>
  MARKER_CURRENCIES.find(([re]) => re.test(marker.trim()))?.[1] ?? [];

const CURRENCY = String.raw`(US\$|R\$|\$|USD|MXN|COP|ARS|BRL)`;
const WORDS = String.raw`(USD|MXN|COP|ARS|BRL|pesos?|d[oó]lar(?:es)?|reais|real)(?!\p{L})`;
const NUMBER = String.raw`(\d[\d.,]*\d|\d)`;
const AMOUNT_PATTERN = new RegExp(String.raw`${CURRENCY}\s*${NUMBER}|${NUMBER}\s*${WORDS}`, "giu");

const MONTHS =
  "enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|" +
  "janeiro|fevereiro|março|maio|junho|julho|setembro|outubro|novembro|dezembro";

/** Number-like tokens that are not money: ids, masked card digits, dates, times and years after a month name. */
const NOT_MONEY: RegExp[] = [
  /\b[A-Z]{1,4}-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g,
  /[*•xX]{2,}\s?\d{2,4}\b/g,
  /\b\d{4}-\d{1,2}-\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?)?\b/g,
  /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b(?![.,]?\d)/g,
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
  new RegExp(String.raw`(?<=(?:${MONTHS})(?:\s+(?:de|del))?\s+)(?:19|20)\d{2}\b`, "giu"),
];
// A bare dd.mm would look like a two-decimal amount; it is only excluded with slashes or dashes above.

const BARE_NUMBER = /(?<![\p{L}\d.,])\d+(?:[.,]\d+)*(?![\p{L}\d])/gu;

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

const grounded = (facts: FactAmount[], amount: number, currencies: string[] | null) =>
  facts.some(
    (f) => Math.abs(f.value - amount) < 0.005 && (currencies === null || currencies.includes(f.currency.toUpperCase())),
  );

/** True when every money-looking number in the text matches a fact (and its currency when one is written). */
function amountsGrounded(text: string, facts: FactAmount[]): boolean {
  let rest = NOT_MONEY.reduce((t, re) => t.replace(re, " "), text);
  let ok = true;
  rest = rest.replace(AMOUNT_PATTERN, (match, prefix?: string, n1?: string, n2?: string, suffix?: string) => {
    const raw = n1 ?? n2;
    const marker = prefix ?? suffix;
    if (raw && marker && !grounded(facts, parseAmount(raw), currenciesFor(marker))) ok = false;
    return " ".repeat(match.length);
  });
  for (const m of rest.matchAll(BARE_NUMBER)) {
    const raw = m[0];
    const looksLikeMoney = /[.,]\d{2}$/.test(raw) || raw.replace(/\D/g, "").length >= 3;
    if (looksLikeMoney && !grounded(facts, parseAmount(raw), null)) ok = false;
  }
  return ok;
}

// ---- Commitments ---------------------------------------------------------------------------------------------

/**
 * Forbidden promises. Unicode-aware boundaries are used throughout because `\b` treats accented letters as
 * non-word characters ("aprobará" would slip through). Broad stems cover verbs whose nouns are themselves
 * promises (reembolso, estorno); the other verbs are matched only in first-person, future or periphrastic
 * forms so that neutral nouns and infinitives in explanations ("el bloqueo preventivo", "la anulación figura
 * en su estado de cuenta", "puede cancelar la suscripción") stay allowed.
 */
const BROAD_STEMS = String.raw`reembols\p{L}*|reintegr\p{L}*|devolv\p{L}*|garantiz\p{L}*|estorn\p{L}*|ressarc\p{L}*|garantim\p{L}*`;
const LEGACY_FORMS = String.raw`abon(?:a(?:r|mos|remos|ré|rá|ndo)|ad[oa]s?)\p{L}*|aprob(?:ad[oa]s?|amos|aremos|aré|ará|arán)\p{L}*|aprov(?:ad[oa]s?|amos|aremos|arei|aré|ará|arão)\p{L}*`;

/** Verb roots with their theme vowel; conjugated promise forms are generated from these. */
const PROMISE_VERBS: [root: string, theme: "a" | "e" | "i"][] = [
  ["bloque", "a"],
  ["acredit", "a"],
  ["credit", "a"],
  ["revers", "a"],
  ["anul", "a"],
  ["cancel", "a"],
  ["aprob", "a"],
  ["aprov", "a"],
  ["abon", "a"],
  ["revert", "i"],
  ["revert", "e"],
  ["restitu", "i"],
  ["reembols", "a"],
  ["devolv", "e"],
];
const conjugated = PROMISE_VERBS.map(
  ([root, v]) => `${root}${v}(?:remos|ré|rá|rán|rei|rão|mos)`,
).join("|");
const infinitive = PROMISE_VERBS.map(([root, v]) => `${root}${v}r`).join("|");
const AUX = String.raw`vamos\s+a|voy\s+a|vamos|vou|iremos|irei|procederemos\s+a|procedemos\s+a|podemos|nos\s+comprometemos\s+a|nos\s+encargaremos\s+de`;
const PERIPHRASTIC = String.raw`(?:${AUX})\s+(?:${infinitive})(?:l[aeo]s?|lhe)?`;
const IN_FAVOR = String.raw`(?:resolv|resuelv)\p{L}*(?:\s+\p{L}+){0,3}\s+(?:a|em)\s+(?:su|tu|seu|sua)\s+favor`;
const TIMELINE = String.raw`(?:en|dentro\s+de|em|até)\s+\d+\s+(?:d[ií]as|horas)`;

const COMMITMENT = new RegExp(
  String.raw`(?<!\p{L})(?:${PERIPHRASTIC}|${IN_FAVOR}|${conjugated}|${BROAD_STEMS}|${LEGACY_FORMS}|${TIMELINE})(?!\p{L})`,
  "iu",
);

// ---- Language ------------------------------------------------------------------------------------------------

// Unicode-aware word boundaries: JavaScript's \b treats accented letters as non-word characters.
const ES_MARKERS = /(?<!\p{L})(?:el|los|las|usted|cuenta|cargo|puedo|gracias|sí|su|del|ya|eso|esto|son|también|fue)(?!\p{L})|ñ|¿|¡/giu;
const PT_MARKERS = /(?<!\p{L})(?:você|não|sua|seu|conta|cobrança|posso|obrigad[oa]|é|do|da|já|isso|isto|são|também|nós|foi)(?!\p{L})|ção|ções|ã|õ/giu;

export function detectLanguage(text: string): "es" | "pt" | "unknown" {
  const es = text.match(ES_MARKERS)?.length ?? 0;
  const pt = text.match(PT_MARKERS)?.length ?? 0;
  if (es === pt) return "unknown";
  return es > pt ? "es" : "pt";
}

/** Gate 7: nothing reaches the customer unless every number and id is grounded and no commitment is improvised. */
export function responseGate(rawText: string, facts: ResponseFacts, ctx: ResponseContext): ResponseCheck {
  // Full-width digits and zero-width characters must not hide anything from the checks below.
  const text = normalizeText(rawText);
  const rules = new Set<ResponseRuleId>();
  if (rawText.includes(ctx.canary) || text.includes(normalizeText(ctx.canary))) rules.add("RS_CANARY");
  const masked = maskPii(text);
  if (masked.found.length > 0) rules.add("RS_PII");

  for (const id of text.match(ID_PATTERN) ?? []) {
    if (!facts.ids.includes(id)) rules.add("RS_ID");
  }

  // Scanned on the masked text: PII digits (cards, documents, phones) are reported as RS_PII, not as amounts.
  if (!amountsGrounded(masked.text, facts.amounts)) rules.add("RS_AMOUNT");

  const withoutTemplates = facts.templates.reduce((t, tpl) => t.replaceAll(normalizeText(tpl), " "), text);
  if (COMMITMENT.test(withoutTemplates)) rules.add("RS_COMMIT");

  const lang = detectLanguage(text);
  if (lang !== "unknown" && lang !== ctx.language) rules.add("RS_LANG");

  const ruleIds = [...rules].sort();
  return { ok: ruleIds.length === 0, ruleIds };
}
