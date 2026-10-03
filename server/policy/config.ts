/** Synthetic team policy. Every report labels these values as synthetic. */
export interface Policy {
  version: string;
  /** Simulated "today": last date in the dataset. */
  clock: string;
  maxAutoUsd: number;
  fraudScore: number;
  maxDisputeAgeDays: number;
  maxTxPerDispute: number;
  riskEscalate: number;
  /** Transaction types eligible for automatic dispute intake; anything else escalates. */
  disputableTypes: readonly string[];
  /** Business days quoted in the dispute-created template. */
  disputeReviewDays: number;
  /** Router confidence below this clarifies instead of acting. */
  routerThreshold: number;
}

export const POLICY: Policy = {
  version: "2026-10-03.1",
  clock: "2026-06-17",
  maxAutoUsd: 250,
  fraudScore: 30,
  maxDisputeAgeDays: 90,
  maxTxPerDispute: 2,
  riskEscalate: 3,
  disputableTypes: ["Purchase", "Withdrawal", "Adjustment"],
  disputeReviewDays: 10,
  routerThreshold: 0.6,
};

export interface Budgets {
  maxTurns: number;
  maxLlmCallsPerTurn: number;
  maxTokensPerSession: number;
  dailySpendUsd: number;
}

export const BUDGETS: Budgets = {
  maxTurns: 30,
  maxLlmCallsPerTurn: 3,
  maxTokensPerSession: 40_000,
  dailySpendUsd: 5,
};
