import type { Embedder } from "./embedder";
import { estimateTokens } from "./embedder";
import type { SpendLedger } from "./ledger";
import { type Llm, costUsd } from "./types";

/** A call was refused because it could cross the project cap or this run's limit. */
export class SpendCapError extends Error {
  readonly ruleId = "BUD_TOTAL";
  constructor(message: string) {
    super(`BUD_TOTAL: ${message}`);
  }
}

/**
 * Spend guard for one offline run (paraphrase generation, training, evaluation): every call is checked against
 * the project-wide ledger cap and this run's own limit before it is made, and recorded after.
 */
export class RunBudget {
  private readonly start: number;
  private reserved = 0;

  constructor(
    readonly ledger: SpendLedger,
    readonly runLimitUsd: number,
    readonly source: string,
  ) {
    if (!Number.isFinite(runLimitUsd) || runLimitUsd < 0) throw new Error(`invalid run limit: ${runLimitUsd}`);
    this.start = ledger.total();
  }

  spent(): number {
    return this.ledger.total() - this.start;
  }

  check(estimateUsd: number): void {
    if (this.ledger.total() + this.reserved + estimateUsd > this.ledger.capUsd)
      throw new SpendCapError("project LLM spend cap reached");
    if (this.spent() + this.reserved + estimateUsd > this.runLimitUsd)
      throw new SpendCapError(`run limit of $${this.runLimitUsd} reached`);
    this.reserved += estimateUsd;
  }

  release(estimateUsd: number): void {
    this.reserved -= estimateUsd;
  }

  record(usd: number, model: string, purpose: string): void {
    this.ledger.record(usd, { model, purpose, source: this.source });
  }
}

/** Wraps a chat model so every call is budget-checked (worst case: full output budget) and recorded. */
export function meteredLlm(llm: Llm, budget: RunBudget, purpose: string): Llm {
  return {
    model: llm.model,
    async generate(req) {
      const estimate = costUsd(llm.model, Math.ceil((req.system.length + req.user.length) / 3), req.maxOutputTokens);
      budget.check(estimate);
      try {
        const res = await llm.generate(req);
        budget.record(costUsd(res.model, res.inputTokens, res.outputTokens), res.model, purpose);
        return res;
      } finally {
        budget.release(estimate);
      }
    },
  };
}

/** Wraps an embedder so every batch is budget-checked and recorded. */
export function meteredEmbedder(embedder: Embedder, budget: RunBudget, purpose: string): Embedder {
  return {
    model: embedder.model,
    dim: embedder.dim,
    async embed(texts, signal) {
      const estimate = costUsd(embedder.model, estimateTokens(texts), 0);
      budget.check(estimate);
      try {
        const res = await embedder.embed(texts, signal);
        budget.record(costUsd(embedder.model, res.inputTokens, 0), embedder.model, purpose);
        return res;
      } finally {
        budget.release(estimate);
      }
    },
  };
}
