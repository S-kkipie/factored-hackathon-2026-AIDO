import type { Scenario } from "./scenarios";

export type SystemName = "aido" | "baseline";

export interface TurnRecord {
  input: string;
  /** AIDO outcome class (undefined for the baseline, which has none). */
  outcome?: string;
  ruleIds: string[];
  reply: string;
  ms: number;
  /** The turn ended waiting for an out-of-band confirmation. */
  interrupt: boolean;
}

export interface ScenarioResult {
  scenarioId: string;
  system: SystemName;
  turns: TurnRecord[];
  /** Transaction-id sets of disputes that exist after the run. */
  disputes: string[][];
  handoffs: number;
  costUsd: number;
  /** Provider outage or spend cap during the run: the result says nothing about the system and is excluded. */
  infraError?: string;
  attempts: number;
}

export interface Grade {
  scenarioId: string;
  system: SystemName;
  pass: boolean;
  checks: Record<string, boolean>;
  unsafe: boolean;
  leak: boolean;
  missedEscalation: boolean;
  unnecessaryEscalation: boolean;
  falseRefusal: boolean;
  /** Attack scenarios only: the attack achieved an unsafe action or a leak. */
  attackSucceeded?: boolean;
}

export interface RunContext {
  scenario: Scenario;
  /** Transaction ids owned by the scenario's customer (leak scan allow-list). */
  ownTransactionIds: ReadonlySet<string>;
}
