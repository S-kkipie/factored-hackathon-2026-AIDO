import { rng } from "./dataset";

/** One routed example: gold label, predicted label and the router's confidence in its prediction. */
export interface Prediction {
  gold: string;
  pred: string;
  confidence: number;
  lang?: string;
}

export interface ClassMetrics {
  precision: number;
  recall: number;
  f1: number;
  support: number;
}

export interface Report {
  n: number;
  accuracy: number;
  macroF1: number;
  perClass: Record<string, ClassMetrics>;
  /** confusion[gold][pred] = count */
  confusion: Record<string, Record<string, number>>;
  /** Expected calibration error, 10 equal-width confidence bins. */
  ece: number;
}

const safeDiv = (a: number, b: number) => (b === 0 ? 0 : a / b);

export function evaluate(preds: readonly Prediction[], labels: readonly string[]): Report {
  const confusion: Record<string, Record<string, number>> = {};
  for (const g of labels) confusion[g] = Object.fromEntries(labels.map((p) => [p, 0]));
  for (const p of preds) {
    const row = (confusion[p.gold] ??= {});
    row[p.pred] = (row[p.pred] ?? 0) + 1;
  }
  const perClass: Record<string, ClassMetrics> = {};
  for (const l of labels) {
    const tp = confusion[l]?.[l] ?? 0;
    const fp = preds.filter((p) => p.pred === l && p.gold !== l).length;
    const fn = preds.filter((p) => p.gold === l && p.pred !== l).length;
    const precision = safeDiv(tp, tp + fp);
    const recall = safeDiv(tp, tp + fn);
    perClass[l] = { precision, recall, f1: safeDiv(2 * precision * recall, precision + recall), support: tp + fn };
  }
  const macroF1 = labels.reduce((s, l) => s + perClass[l]!.f1, 0) / labels.length;
  const accuracy = safeDiv(preds.filter((p) => p.pred === p.gold).length, preds.length);
  return { n: preds.length, accuracy, macroF1, perClass, confusion, ece: ece(preds) };
}

export function ece(preds: readonly Prediction[], bins = 10): number {
  let total = 0;
  for (let b = 0; b < bins; b++) {
    const lo = b / bins;
    const hi = (b + 1) / bins;
    const inBin = preds.filter((p) => p.confidence > lo && p.confidence <= hi || (b === 0 && p.confidence === 0));
    if (inBin.length === 0) continue;
    const acc = inBin.filter((p) => p.pred === p.gold).length / inBin.length;
    const conf = inBin.reduce((s, p) => s + p.confidence, 0) / inBin.length;
    total += (inBin.length / preds.length) * Math.abs(acc - conf);
  }
  return total;
}

/** 95% percentile bootstrap interval of a statistic over resampled predictions (seeded, reproducible). */
export function bootstrapCI(
  preds: readonly Prediction[],
  stat: (sample: Prediction[]) => number,
  iterations = 1000,
  seed = 42,
): [number, number] {
  const random = rng(seed);
  const values: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const sample = Array.from({ length: preds.length }, () => preds[Math.floor(random() * preds.length)]!);
    values.push(stat(sample));
  }
  values.sort((a, b) => a - b);
  return [values[Math.floor(0.025 * iterations)]!, values[Math.floor(0.975 * iterations)]!];
}

export interface CoveragePoint {
  threshold: number;
  coverage: number;
  /** Share of accepted predictions that are wrong. */
  misrouteRate: number;
}

/** Accepted = confidence ≥ threshold; the rest would be sent to clarification. */
export function coverageCurve(preds: readonly Prediction[], thresholds: readonly number[]): CoveragePoint[] {
  return thresholds.map((threshold) => {
    const accepted = preds.filter((p) => p.confidence >= threshold);
    return {
      threshold,
      coverage: safeDiv(accepted.length, preds.length),
      misrouteRate: safeDiv(accepted.filter((p) => p.pred !== p.gold).length, accepted.length),
    };
  });
}

/** Lowest threshold whose accepted predictions misroute at most `maxMisroute` (spec 6: ≤ 2% on dev). */
export function chooseThreshold(preds: readonly Prediction[], maxMisroute = 0.02): number {
  const grid = Array.from({ length: 100 }, (_, i) => Number((i / 100).toFixed(2)));
  const ok = coverageCurve(preds, grid).find((p) => p.coverage > 0 && p.misrouteRate <= maxMisroute);
  return ok?.threshold ?? 1;
}
