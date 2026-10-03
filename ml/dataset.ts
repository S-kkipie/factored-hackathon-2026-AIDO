import type { Language } from "../server/auth";
import { sha256Hex } from "../server/hash";
import type { RouteLabel } from "../server/router/types";

/** Every label a router may answer (spec 3.1 intents plus greeting). Order is the model's class order. */
export const ROUTER_LABELS = [
  "check_balance",
  "list_transactions",
  "explain_charge",
  "dispute_charge",
  "request_human",
  "out_of_scope",
  "greeting",
] as const satisfies readonly RouteLabel[];

export const isRouterLabel = (x: string): x is RouteLabel => (ROUTER_LABELS as readonly string[]).includes(x);

export interface Utterance {
  id: string;
  lang: Language;
  /** Regional variant: MX, CO, AR (Spanish) or BR (Portuguese). */
  variant: string;
  label: RouteLabel;
  text: string;
  /** Seed family for train/dev splitting; paraphrases inherit their seed's family. Absent in the test set. */
  family?: string;
  /** `human` for hand-written rows, `gemini-paraphrase@<version>` for generated ones. */
  source: string;
}

/** RFC 4180 CSV parser (quoted fields, doubled quotes, commas and newlines inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/** Loads a labeled CSV with header `id,lang,variant,label,text[,family]`. Throws on unknown labels or languages. */
export function readUtterancesCsv(text: string, source: string): Utterance[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new Error("empty CSV");
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0 && name !== "family") throw new Error(`CSV is missing column '${name}'`);
    return i;
  };
  const [id, lang, variant, label, txt, family] = ["id", "lang", "variant", "label", "text", "family"].map(col) as number[];
  return rows.map((r, n) => {
    const l = r[label!] ?? "";
    const lg = r[lang!] ?? "";
    if (!isRouterLabel(l)) throw new Error(`row ${n + 2}: unknown label '${l}'`);
    if (lg !== "es" && lg !== "pt") throw new Error(`row ${n + 2}: unknown language '${lg}'`);
    const t = (r[txt!] ?? "").trim();
    if (t.length === 0) throw new Error(`row ${n + 2}: empty text`);
    return {
      id: r[id!] ?? `row${n + 2}`,
      lang: lg,
      variant: r[variant!] ?? "",
      label: l,
      text: t,
      ...(family! >= 0 && r[family!] ? { family: r[family!] } : {}),
      source,
    };
  });
}

export const readJsonl = <T>(text: string): T[] =>
  text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);

export const toJsonl = (rows: readonly unknown[]): string => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

/** The test set is frozen by hash before any model selection (spec 6): a changed file fails loudly. */
export async function loadFrozenTestSet(csvPath: string, hashPath: string): Promise<Utterance[]> {
  const text = await Bun.file(csvPath).text();
  const expected = (await Bun.file(hashPath).text()).trim().split(/\s+/)[0];
  const actual = sha256Hex(text);
  if (actual !== expected) throw new Error(`frozen test set changed: expected ${expected}, got ${actual}`);
  return readUtterancesCsv(text, "human");
}

/** Accent-, case- and punctuation-insensitive form used for duplicate checks. */
export const normalizeForDedup = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Deterministic PRNG (mulberry32) so splits, initialization and bootstrap are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
