/** Inference for the multinomial logistic-regression router; training lives in ml/logreg.ts. */
export interface LogRegModel {
  labels: string[];
  dim: number;
  /** labels.length × dim weights, row-major per class. */
  weights: number[][];
  bias: number[];
  /** Softmax temperature fitted on the dev set (temperature scaling); 1 means uncalibrated. */
  temperature: number;
}

export function softmax(logits: readonly number[], temperature = 1): number[] {
  const scaled = logits.map((z) => z / temperature);
  const max = Math.max(...scaled);
  const exps = scaled.map((z) => Math.exp(z - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

export function logits(m: Pick<LogRegModel, "weights" | "bias">, x: readonly number[]): number[] {
  return m.weights.map((w, k) => w.reduce((s, wi, i) => s + wi * x[i]!, m.bias[k]!));
}

export function predictProba(m: LogRegModel, x: readonly number[]): number[] {
  return softmax(logits(m, x), m.temperature);
}
