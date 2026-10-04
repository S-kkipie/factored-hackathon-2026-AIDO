import { sha256Hex } from "../../server/hash";
import { type Embedder, estimateTokens, l2normalize } from "../../server/llm/embedder";

/**
 * Deterministic fake embedder: hashes character trigrams of the folded text into `dim` buckets, so texts that share
 * words land close together. Good enough to make a linear classifier learn in tests; no network.
 */
export function fakeEmbedder(dim = 64): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  const vec = (text: string) => {
    const v = new Array<number>(dim).fill(0);
    const t = ` ${text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()} `;
    for (let i = 0; i + 3 <= t.length; i++) {
      const h = Number.parseInt(sha256Hex(t.slice(i, i + 3)).slice(0, 8), 16);
      v[h % dim]! += 1;
    }
    return l2normalize(v);
  };
  return {
    model: "gemini-embedding-001",
    dim,
    calls,
    async embed(texts) {
      calls.push([...texts]);
      return { vectors: texts.map(vec), inputTokens: estimateTokens(texts) };
    },
  };
}
