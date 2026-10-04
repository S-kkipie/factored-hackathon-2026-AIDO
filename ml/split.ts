import { type Utterance, rng, shuffle } from "./dataset";

export const dot = (a: readonly number[], b: readonly number[]): number => a.reduce((s, x, i) => s + x * b[i]!, 0);

/** Family id with its language prefix removed, e.g. "es-dsp-1" and "pt-dsp-1" both become "dsp-1". */
const pairId = (family: string): string => family.replace(/^(es|pt)-/, "");

/**
 * Splits by seed family so paraphrases of one seed never sit on both sides (spec 6 leakage prevention). ES and PT
 * seeds are translation pairs sharing a family id with only the language prefix differing (e.g. "es-dsp-1" and
 * "pt-dsp-1"): grouping is by that shared id with the prefix stripped, per label, so both languages of a pair
 * always land on the same side. For every label, `devShare` of its pair groups (at least one when there are two
 * or more) go to dev.
 */
export function splitByFamily(rows: readonly Utterance[], devShare: number, seed: number) {
  const random = rng(seed);
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.family) throw new Error(`training row ${r.id} has no family`);
    const key = r.label;
    const pid = pairId(r.family);
    const fams = groups.get(key) ?? [];
    if (!fams.includes(pid)) fams.push(pid);
    groups.set(key, fams);
  }
  const devPairIds = new Set<string>();
  for (const fams of groups.values()) {
    const k = fams.length < 2 ? 0 : Math.max(1, Math.round(fams.length * devShare));
    for (const f of shuffle(fams.sort(), random).slice(0, k)) devPairIds.add(f);
  }
  const inDev = (r: Utterance) => devPairIds.has(pairId(r.family!));
  return {
    train: rows.filter((r) => !inDev(r)),
    dev: rows.filter(inDev),
    devFamilies: [...new Set(rows.filter(inDev).map((r) => r.family!))].sort(),
  };
}

/**
 * Drops training rows whose embedding has cosine similarity above `threshold` with any test row (vectors are unit
 * length, so cosine is the dot product). The frozen test set itself never changes.
 */
export function dropNearTest(
  train: readonly Utterance[],
  trainVecs: ReadonlyMap<string, number[]>,
  testVecs: readonly number[][],
  threshold = 0.95,
): { kept: Utterance[]; dropped: Utterance[] } {
  const kept: Utterance[] = [];
  const dropped: Utterance[] = [];
  for (const r of train) {
    const v = trainVecs.get(r.text);
    if (!v) throw new Error(`no embedding for training row ${r.id}`);
    (testVecs.some((t) => dot(v, t) > threshold) ? dropped : kept).push(r);
  }
  return { kept, dropped };
}

/** Stratified sample: up to `perGroup` rows for each (label, language), seeded. */
export function stratifiedSample(rows: readonly Utterance[], perGroup: number, seed: number): Utterance[] {
  const random = rng(seed);
  const groups = new Map<string, Utterance[]>();
  for (const r of rows) groups.set(`${r.label}|${r.lang}`, [...(groups.get(`${r.label}|${r.lang}`) ?? []), r]);
  return [...groups.keys()].sort().flatMap((k) => shuffle(groups.get(k)!, random).slice(0, perGroup));
}
