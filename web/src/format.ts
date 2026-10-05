import type { Language } from "./api";

const LOCALE: Record<Language, string> = { es: "es-MX", pt: "pt-BR" };

export function money(amount: number, currency: string, lang: Language): string {
  try {
    return new Intl.NumberFormat(LOCALE[lang], { style: "currency", currency, currencyDisplay: "code", maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Dates in the data are ISO strings without zone (bank-local time): format them as-is, never shift by the viewer's zone. */
export function shortDate(iso: string, lang: Language): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Intl.DateTimeFormat(LOCALE[lang], { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(Date.UTC(y, m - 1, d));
}

export function timeOf(iso: string): string {
  return iso.length >= 16 ? iso.slice(11, 16) : "";
}

/** "hace 4 min" / "há 4 min" from a real (zoned) timestamp. */
export function ago(iso: string, now: number, lang: Language = "es"): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  const pre = lang === "es" ? "hace" : "há";
  if (s < 60) return `${pre} ${s} s`;
  if (s < 3600) return `${pre} ${Math.floor(s / 60)} min`;
  if (s < 86400) return `${pre} ${Math.floor(s / 3600)} h`;
  return `${pre} ${Math.floor(s / 86400)} d`;
}

export const STATUS_LABEL: Record<Language, Record<string, string>> = {
  es: { Approved: "Aprobado", Pending: "Pendiente", Declined: "Rechazado", Reversed: "Revertido", Active: "Activa" },
  pt: { Approved: "Aprovado", Pending: "Pendente", Declined: "Recusado", Reversed: "Estornado", Active: "Ativa" },
};
