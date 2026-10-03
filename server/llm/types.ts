export interface LlmRequest {
  system: string;
  user: string;
  /** Ask for a JSON object (responseMimeType application/json). */
  json: boolean;
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface LlmResponse {
  text: string;
  model: string;
  inputTokens: number;
  /** Output plus thinking tokens: both are billed at the output rate. */
  outputTokens: number;
}

/** Provider seam: Gemini in production, a scripted fake in tests. */
export interface Llm {
  readonly model: string;
  generate(req: LlmRequest): Promise<LlmResponse>;
}

/** USD per 1M tokens for the pinned model (Gemini 3.8 Flash introductory price, 2026). */
export const PRICING: Record<string, { input: number; output: number }> = {
  "gemini-3.8-flash": { input: 0.75, output: 3.75 },
};

/** Unknown models are priced at a deliberately high rate so the spend cap fails safe. */
export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] ?? { input: 5, output: 20 };
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}
