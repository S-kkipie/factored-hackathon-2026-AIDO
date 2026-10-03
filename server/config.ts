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
    modelTimeoutMs: Number(env.MODEL_TIMEOUT_MS ?? 15000),
    canarySecret: secret,
    port: Number(env.PORT ?? 8080),
  };
}
