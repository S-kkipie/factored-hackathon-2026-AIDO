import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");

export interface PipelineConfig {
  rawDir: string;
  warehousePath: string;
  servingPath: string;
  martsDir: string;
  reportsDir: string;
  runsDir: string;
  /** Simulated "today" (last date in the dataset). */
  clock: string;
  /** Transactions kept in serving.sqlite, counted back from the clock. */
  windowDays: number;
  /** Window used to qualify demo personas. */
  recentDays: number;
  subsetSize: number;
  seed: number;
  /** Synthetic policy: largest amount eligible for automatic dispute intake. */
  maxAutoUsd: number;
  /** Synthetic policy: fraud_score at or above this requires a human. */
  fraudScore: number;
}

export function defaultConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    rawDir: join(ROOT, "data/raw"),
    warehousePath: join(ROOT, "data/warehouse.duckdb"),
    servingPath: join(ROOT, "data/serving.sqlite"),
    martsDir: join(ROOT, "data/marts"),
    reportsDir: join(ROOT, "reports"),
    runsDir: join(ROOT, "data/runs"),
    clock: "2026-06-17",
    windowDays: 180,
    recentDays: 90,
    subsetSize: 2000,
    seed: 42,
    maxAutoUsd: 250,
    fraudScore: 30,
    ...overrides,
  };
}
