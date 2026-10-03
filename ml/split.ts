import { type Utterance, rng, shuffle } from "./dataset";

export const dot = (a: readonly number[], b: readonly number[]): number => a.reduce((s, x, i) => s + x * b[i]!, 0);

/**
 * Splits by seed family so paraphrases of one seed never sit on both sides (spec 6 leakage prevention). For every
 * (label, language) pair, `devShare` of its families (at least one when there are two or more) go to dev.
 */
export function splitByFamily(rows: readonly Utterance[], devShare: number, seed: number) {
  const random = rng(seed);
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.family) throw new Error(`training row ${r.id} has no family`);
    const key = `${r.label}|${r.lang}`;
    const fams = groups.get(key) ?? [];
    if (!fams.includes(r.family)) fams.push(r.family);
    groups.set(key, fams);
  }
  const devFamilies = new Set<string>();
  for (const fams of groups.values()) {
    const k = fams.length < 2 ? 0 : Math.max(1, Math.round(fams.length * devShare));
    for (const f of shuffle(fams.sort(), random).slice(0, k)) devFamilies.add(f);
  }
  return {
    train: rows.filter((r) => !devFamilies.has(r.family!)),
    dev: rows.filter((r) => devFamilies.has(r.family!)),
    devFamilies: [...devFamilies].sort(),
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
