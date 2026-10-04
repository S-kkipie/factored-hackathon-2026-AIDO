/**
 * Multinomial logistic regression with L2 regularization, trained by full-batch gradient descent with Adam.
 * Small and dependency-free: the router has a few thousand 768-dim examples and 7 classes.
 */
import { type LogRegModel, logits, softmax } from "../server/router/linear";

export { type LogRegModel, logits, predictProba, softmax } from "../server/router/linear";

export interface TrainOptions {
  l2: number;
  epochs: number;
  learningRate: number;
}

const DEFAULTS: TrainOptions = { l2: 1e-3, epochs: 300, learningRate: 0.05 };

export function train(X: readonly number[][], y: readonly string[], labels: readonly string[], options: Partial<TrainOptions> = {}): LogRegModel {
  const o = { ...DEFAULTS, ...options };
  const K = labels.length;
  const dim = X[0]?.length ?? 0;
  if (X.length === 0 || X.length !== y.length) throw new Error("training data is empty or misaligned");
  const index = new Map(labels.map((l, i) => [l, i]));
  const yi = y.map((l) => {
    const k = index.get(l);
    if (k === undefined) throw new Error(`unknown label ${l}`);
    return k;
  });

  const W = Array.from({ length: K }, () => new Array<number>(dim).fill(0));
  const b = new Array<number>(K).fill(0);
  // Adam state.
  const mW = W.map((r) => r.map(() => 0));
  const vW = W.map((r) => r.map(() => 0));
  const mb = b.map(() => 0);
  const vb = b.map(() => 0);
  const [b1, b2, eps] = [0.9, 0.999, 1e-8];
  const n = X.length;

  for (let epoch = 1; epoch <= o.epochs; epoch++) {
    const gW = W.map((r) => r.map(() => 0));
    const gb = b.map(() => 0);
    for (let i = 0; i < n; i++) {
      const x = X[i]!;
      const p = softmax(logits({ weights: W, bias: b }, x));
      for (let k = 0; k < K; k++) {
        const err = (p[k]! - (yi[i] === k ? 1 : 0)) / n;
        gb[k]! += err;
        const row = gW[k]!;
        for (let d = 0; d < dim; d++) row[d]! += err * x[d]!;
      }
    }
    const c1 = 1 - b1 ** epoch;
    const c2 = 1 - b2 ** epoch;
    for (let k = 0; k < K; k++) {
      for (let d = 0; d < dim; d++) {
        const g = gW[k]![d]! + o.l2 * W[k]![d]!;
        mW[k]![d] = b1 * mW[k]![d]! + (1 - b1) * g;
        vW[k]![d] = b2 * vW[k]![d]! + (1 - b2) * g * g;
        W[k]![d]! -= (o.learningRate * (mW[k]![d]! / c1)) / (Math.sqrt(vW[k]![d]! / c2) + eps);
      }
      mb[k] = b1 * mb[k]! + (1 - b1) * gb[k]!;
      vb[k] = b2 * vb[k]! + (1 - b2) * gb[k]! * gb[k]!;
      b[k]! -= (o.learningRate * (mb[k]! / c1)) / (Math.sqrt(vb[k]! / c2) + eps);
    }
  }
  return { labels: [...labels], dim, weights: W, bias: b, temperature: 1 };
}

/** Temperature scaling: picks T minimizing negative log-likelihood on held-out data (grid search, 0.25–5). */
export function fitTemperature(m: LogRegModel, X: readonly number[][], y: readonly string[]): number {
  const idx = new Map(m.labels.map((l, i) => [l, i]));
  const z = X.map((x) => logits(m, x));
  let best = { t: 1, nll: Number.POSITIVE_INFINITY };
  for (let t = 0.25; t <= 5.0001; t += 0.05) {
    const nll = z.reduce((s, zi, i) => s - Math.log(Math.max(softmax(zi, t)[idx.get(y[i]!)!]!, 1e-12)), 0);
    if (nll < best.nll) best = { t, nll };
  }
  return Number(best.t.toFixed(2));
}
