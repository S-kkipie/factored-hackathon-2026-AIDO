import { join } from "node:path";
import { ROOT } from "../pipeline/config";

export interface ServerConfig {
  servingPath: string;
  opsPath: string;
  jwtSecret: Uint8Array;
  sessionTtlSeconds: number;
  demoPin: string;
  agentPin: string;
  /** Kill switch: no model calls at all, templates and escalation only. */
  safeMode: boolean;
  /** Absent key means no model: the graph runs on templates and escalation only. */
  geminiApiKey: string | null;
  /** Pinned model version (spec 4.5). */
  geminiModel: string;
  modelTimeoutMs: number;
  /** Secret mixed into the per-session canary token that must never appear in a reply. */
  canarySecret: string;
  port: number;
  /** Shared, persistent record of every LLM call's cost (server, smoke, eval, ML scripts). */
  spendLedgerPath: string;
  /** Hard cap on total project LLM spend in USD (default 3). */
  llmTotalCapUsd: number;
  /** `ROUTER`: auto (experiment's selection), keyword or embed-lr. */
  router: "auto" | "keyword" | "embed-lr";
  /** Built web app served by the API process (`WEB_DIR`, default `web/dist`); absent build means API only. */
  webDir: string;
}

/** Parses a required-positive-integer env var, falling back when unset; throws a clear message otherwise. */
function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a finite positive integer, got '${raw}'`);
  }
  return n;
}

function nonNegativeNumber(name: string, raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a finite non-negative number, got '${raw}'`);
  return n;
}

function routerChoice(raw: string | undefined): ServerConfig["router"] {
  const v = raw ?? "auto";
  if (v !== "auto" && v !== "keyword" && v !== "embed-lr") throw new Error(`ROUTER must be auto, keyword or embed-lr, got '${raw}'`);
  return v;
}

export function loadServerConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const secret = env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error("JWT_SECRET must be set to at least 32 characters");
  return {
    servingPath: env.SERVING_PATH ?? join(ROOT, "data/serving.sqlite"),
    opsPath: env.OPS_PATH ?? join(ROOT, "data/ops.sqlite"),
    jwtSecret: new TextEncoder().encode(secret),
    sessionTtlSeconds: 15 * 60,
    demoPin: env.DEMO_PIN ?? "2468",
    agentPin: env.AGENT_PIN ?? "1357",
    safeMode: env.SAFE_MODE === "1",
    geminiApiKey: env.GEMINI_API_KEY || null,
    geminiModel: env.GEMINI_MODEL ?? "gemini-3.8-flash",
    modelTimeoutMs: positiveInt("MODEL_TIMEOUT_MS", env.MODEL_TIMEOUT_MS, 15000),
    canarySecret: secret,
    port: positiveInt("PORT", env.PORT, 8080),
    spendLedgerPath: env.SPEND_LEDGER_PATH ?? join(ROOT, "data/spend-ledger.sqlite"),
    llmTotalCapUsd: nonNegativeNumber("LLM_TOTAL_CAP_USD", env.LLM_TOTAL_CAP_USD, 3),
    router: routerChoice(env.ROUTER),
    webDir: env.WEB_DIR ?? join(ROOT, "web/dist"),
  };
}
