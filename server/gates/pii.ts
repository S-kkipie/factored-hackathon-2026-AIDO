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
  { kind: "phone", pattern: /\+\d{1,3}[\s-]?\d(?:[\s-]?\d){7,12}\b/g, token: "[PHONE]" },
];

export function maskPii(text: string): { text: string; found: PiiKind[] } {
  const found: PiiKind[] = [];
  let out = text;
  for (const d of DETECTORS) {
    out = out.replace(d.pattern, (match) => {
      if (d.valid && !d.valid(match)) return match;
      if (!found.includes(d.kind)) found.push(d.kind);
      return d.token;
    });
  }
  return { text: out, found };
}
