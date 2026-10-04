import { describe, expect, test } from "bun:test";
import { createGeminiEmbedder, l2normalize } from "../../server/llm/embedder";

describe("createGeminiEmbedder", () => {
  test("batches 250 texts into 3 calls (100/100/50) and returns vectors in input order", async () => {
    const calls: { model: string; contents: string[]; config: unknown }[] = [];
    const client = {
      async embedContent(params: {
        model: string;
        contents: string[];
        config: { taskType: string; outputDimensionality: number; abortSignal?: AbortSignal };
      }) {
        calls.push(params);
        const batchSize = params.contents.length;
        // Each embedding has the requested dimensionality, unit vectors
        const embeddings = params.contents.map((text, idx) => {
          const v = new Array(params.config.outputDimensionality).fill(0);
          v[idx % params.config.outputDimensionality] = 1;
          return { values: v };
        });
        return { embeddings };
      },
    };

    const embedder = createGeminiEmbedder("dummy-key", "gemini-embedding-001", 64, client);
    const texts = Array.from({ length: 250 }, (_, i) => `text ${i}`);
    const result = await embedder.embed(texts);

    expect(calls.length).toBe(3);
    expect(calls[0]!.contents.length).toBe(100);
    expect(calls[1]!.contents.length).toBe(100);
    expect(calls[2]!.contents.length).toBe(50);
    expect(result.vectors.length).toBe(250);
    expect(result.inputTokens).toBeGreaterThan(0);
  });

  test("every vector is unit length after L2 normalization", async () => {
    const client = {
      async embedContent(params: {
        model: string;
        contents: string[];
        config: { taskType: string; outputDimensionality: number; abortSignal?: AbortSignal };
      }) {
        const embeddings = params.contents.map((_, idx) => {
          // Create non-unit vectors: [3, 4] has magnitude 5
          const v = [3, 4, ...new Array(params.config.outputDimensionality - 2).fill(0)];
          return { values: v };
        });
        return { embeddings };
      },
    };

    const embedder = createGeminiEmbedder("dummy-key", "gemini-embedding-001", 5, client);
    const result = await embedder.embed(["a", "b", "c"]);

    for (const vec of result.vectors) {
      const magnitude = Math.hypot(...vec);
      expect(magnitude).toBeCloseTo(1, 5);
    }
  });

  test("passes config with taskType CLASSIFICATION, outputDimensionality, and abortSignal", async () => {
    const configs: unknown[] = [];
    const client = {
      async embedContent(params: {
        model: string;
        contents: string[];
        config: unknown;
      }) {
        configs.push(params.config);
        return { embeddings: [{ values: [1, 0] }, { values: [0, 1] }] };
      },
    };

    const signal = new AbortController().signal;
    const embedder = createGeminiEmbedder("dummy-key", "gemini-embedding-001", 2, client);
    await embedder.embed(["a", "b"], signal);

    expect(configs.length).toBe(1);
    const config = configs[0] as Record<string, unknown>;
    expect(config.taskType).toBe("CLASSIFICATION");
    expect(config.outputDimensionality).toBe(2);
    expect(config.abortSignal).toBe(signal);
  });

  test("throws on embedding count mismatch", async () => {
    const client = {
      async embedContent() {
        return { embeddings: [{ values: [1, 0] }] }; // 1 embedding for 2 requested
      },
    };

    const embedder = createGeminiEmbedder("dummy-key", "gemini-embedding-001", 2, client);
    await expect(embedder.embed(["a", "b"])).rejects.toThrow("embedding count mismatch: 1 for 2");
  });

  test("throws on wrong embedding dimension", async () => {
    const client = {
      async embedContent() {
        return { embeddings: [{ values: [1, 0, 0] }] }; // 3 dimensions, but 2 requested
      },
    };

    const embedder = createGeminiEmbedder("dummy-key", "gemini-embedding-001", 2, client);
    await expect(embedder.embed(["a"])).rejects.toThrow("embedding has the wrong dimension");
  });
});
