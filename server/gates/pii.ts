export type PiiKind = "email" | "cpf" | "curp" | "card" | "id_doc" | "phone";

export function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

export function cpfValid(digits: string): boolean {
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  const check = (n: number) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Number(digits[i]) * (n + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return check(9) === Number(digits[9]) && check(10) === Number(digits[10]);
}

const onlyDigits = (s: string) => s.replace(/\D/g, "");

interface Detector {
  kind: PiiKind;
  pattern: RegExp;
  token: string;
  valid?: (match: string) => boolean;
}

/** Order matters: more specific patterns run first so later ones do not split them. */
const DETECTORS: Detector[] = [
  { kind: "email", pattern: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, token: "[EMAIL]" },
  { kind: "cpf", pattern: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, token: "[CPF]", valid: (m) => cpfValid(onlyDigits(m)) },
  { kind: "curp", pattern: /\b[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d\b/gi, token: "[CURP]" },
  {
    kind: "card",
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    token: "[CARD]",
    valid: (m) => {
      const d = onlyDigits(m);
      return d.length >= 13 && d.length <= 19 && luhnValid(d);
    },
  },
  { kind: "id_doc", pattern: /\b(?:DNI|CC|CE|RG|c[eé]dula)[:\s#nº°.]*(?:\p{L}{1,3}\s*){0,2}\d(?:[\d.\-]*\d){5,}\b/giu, token: "[ID_DOC]" },
  {
    kind: "phone",
    // International (+52 55 1234 5678) or local with phone-style separators: "55 1234 5678", "(11) 91234-5678".
    pattern: /\+\d{1,3}[\s-]?\d(?:[\s-]?\d){7,12}\b|(?<![\d.,])(?:\(\d{2,3}\)\s?|\d{2,3}[\s-])\d{4,5}[\s-]\d{4}(?![\d.,]?\d)/g,
    token: "[PHONE]",
  },
];

const ZERO_WIDTH = /[\u200B-\u200D\uFEFF\u2060]/g;

/** NFKC folds full-width and compatibility digits to ASCII; zero-width characters are removed so they cannot split PII. */
export const normalizeText = (text: string): string => text.normalize("NFKC").replace(ZERO_WIDTH, "");

/** Masks PII. Detection runs on normalized text, and the returned text is the normalized form. */
export function maskPii(text: string): { text: string; found: PiiKind[] } {
  const found: PiiKind[] = [];
  let out = normalizeText(text);
  for (const d of DETECTORS) {
    out = out.replace(d.pattern, (match) => {
      if (d.valid && !d.valid(match)) return match;
      if (!found.includes(d.kind)) found.push(d.kind);
      return d.token;
    });
  }
  return { text: out, found };
}
