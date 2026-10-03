import { describe, expect, test } from "bun:test";
import { rng } from "../../ml/dataset";
import { fitTemperature, predictProba, softmax, train } from "../../ml/logreg";
import { type Prediction, bootstrapCI, chooseThreshold, coverageCurve, ece, evaluate } from "../../ml/metrics";

/** Three gaussian blobs in 4 dimensions. */
function blobs(n: number, seed: number) {
  const r = rng(seed);
  const centers: Record<string, number[]> = { a: [3, 0, 0, 0], b: [0, 3, 0, 0], c: [0, 0, 3, 0] };
  const X: number[][] = [];
  const y: string[] = [];
  for (let i = 0; i < n; i++) {
    const label = ["a", "b", "c"][i % 3]!;
    X.push(centers[label]!.map((c) => c + (r() - 0.5) * 2));
    y.push(label);
  }
  return { X, y };
}

describe("logistic regression", () => {
  test("softmax is a probability distribution and temperature flattens it", () => {
    const p = softmax([2, 1, 0]);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(softmax([2, 1, 0], 5)[0]!).toBeLessThan(p[0]!);
  });

  test("learns separable classes and generalizes to held-out data", () => {
    const tr = blobs(150, 1);
    const te = blobs(60, 2);
    const m = train(tr.X, tr.y, ["a", "b", "c"], { epochs: 200, learningRate: 0.1 });
    const acc = te.X.filter((x, i) => {
      const p = predictProba(m, x);
      return m.labels[p.indexOf(Math.max(...p))] === te.y[i];
    }).length / te.X.length;
    expect(acc).toBeGreaterThan(0.95);
  });

  test("rejects misaligned data and unknown labels", () => {
    expect(() => train([[1]], [], ["a"])).toThrow();
    expect(() => train([[1]], ["z"], ["a"])).toThrow("unknown label");
  });

  test("temperature scaling returns a positive temperature from the grid", () => {
    const tr = blobs(90, 3);
    const m = train(tr.X, tr.y, ["a", "b", "c"], { epochs: 100 });
    const t = fitTemperature(m, blobs(30, 4).X, blobs(30, 4).y);
    expect(t).toBeGreaterThanOrEqual(0.25);
    expect(t).toBeLessThanOrEqual(5);
  });
});

describe("metrics", () => {
  const P = (gold: string, pred: string, confidence: number): Prediction => ({ gold, pred, confidence });
  const preds = [P("a", "a", 0.9), P("a", "b", 0.6), P("b", "b", 0.8), P("b", "b", 0.95), P("c", "c", 0.7), P("c", "a", 0.4)];

  test("per-class precision, recall, F1, macro-F1 and confusion", () => {
    const r = evaluate(preds, ["a", "b", "c"]);
    expect(r.accuracy).toBeCloseTo(4 / 6);
    expect(r.perClass.a).toMatchObject({ precision: 0.5, recall: 0.5, support: 2 });
    expect(r.perClass.b!.precision).toBeCloseTo(2 / 3);
    expect(r.perClass.b!.recall).toBe(1);
    expect(r.confusion.c).toEqual({ a: 1, b: 0, c: 1 });
    expect(r.macroF1).toBeCloseTo((0.5 + 0.8 + 2 / 3) / 3);
  });

  test("ECE is zero for perfectly calibrated confidence and positive otherwise", () => {
    expect(ece([P("a", "a", 1), P("a", "a", 1)])).toBe(0);
    expect(ece([P("a", "b", 0.9)])).toBeCloseTo(0.9);
  });

  test("coverage curve and threshold choice", () => {
    const curve = coverageCurve(preds, [0, 0.65]);
    expect(curve[0]).toEqual({ threshold: 0, coverage: 1, misrouteRate: 2 / 6 });
    expect(curve[1]!.misrouteRate).toBe(0);
    expect(chooseThreshold(preds, 0.02)).toBeGreaterThan(0.6);
    expect(chooseThreshold(preds, 0.02)).toBeLessThanOrEqual(0.7);
    expect(chooseThreshold([P("a", "b", 0.99)], 0.02)).toBe(1);
  });

  test("bootstrap CI brackets the point estimate and is reproducible", () => {
    const acc = (s: Prediction[]) => s.filter((p) => p.gold === p.pred).length / s.length;
    const [lo, hi] = bootstrapCI(preds, acc, 500, 7);
    expect(lo).toBeLessThanOrEqual(4 / 6);
    expect(hi).toBeGreaterThanOrEqual(4 / 6);
    expect(bootstrapCI(preds, acc, 500, 7)).toEqual([lo, hi]);
  });
});
