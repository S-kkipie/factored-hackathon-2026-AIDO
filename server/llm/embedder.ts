import { GoogleGenAI } from "@google/genai";

export interface EmbedResult {
  /** One L2-normalized vector per input text, in input order. */
  vectors: number[][];
  /** The embeddings API returns no usage; estimated as ceil(characters / 4) per text. */
  inputTokens: number;
}

/** Provider seam for text embeddings: Gemini in production, deterministic fakes in tests. */
export interface Embedder {
  readonly model: string;
  readonly dim: number;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<EmbedResult>;
}

export const estimateTokens = (texts: readonly string[]): number =>
  texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0);

export function l2normalize(v: readonly number[]): number[] {
  const norm = Math.hypot(...v);
  return norm === 0 ? [...v] : v.map((x) => x / norm);
}

const BATCH = 100;

/**
 * gemini-embedding-001 with task type CLASSIFICATION. Vectors truncated to `dim` dimensions are not unit length,
 * so they are normalized here (the model card asks for normalization below 3072 dimensions).
 */
export function createGeminiEmbedder(
  apiKey: string,
  model = "gemini-embedding-001",
  dim = 768,
  client?: { embedContent(params: unknown): Promise<{ embeddings?: { values?: number[] }[] }> },
): Embedder {
  const c = client ?? new GoogleGenAI({ apiKey }).models;
  return {
    model,
    dim,
    async embed(texts, signal) {
      const vectors: number[][] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const batch = texts.slice(i, i + BATCH);
        const res = await c.embedContent({
          model,
          contents: [...batch],
          config: { taskType: "CLASSIFICATION", outputDimensionality: dim, abortSignal: signal },
        });
        const got = res.embeddings ?? [];
        if (got.length !== batch.length) throw new Error(`embedding count mismatch: ${got.length} for ${batch.length}`);
        for (const e of got) {
          if (!e.values || e.values.length !== dim) throw new Error("embedding has the wrong dimension");
          vectors.push(l2normalize(e.values));
        }
      }
      return { vectors, inputTokens: estimateTokens(texts) };
    },
  };
}
