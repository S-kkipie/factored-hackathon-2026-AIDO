import { join } from "node:path";
import { ROOT } from "../pipeline/config";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { loadServerConfig } from "./config";
import { openOps } from "./db/ops";
import { openServing } from "./db/serving";
import type { ServingDb } from "./db/serving";
import { CircuitBreaker } from "./gates/budget";
import { createModelArmor } from "./gates/model-armor";
import { BunSqliteSaver } from "./graph/checkpointer";
import { createGeminiLlm } from "./llm/gemini";
import { SpendLedger } from "./llm/ledger";
import { createGeminiEmbedder } from "./llm/embedder";
import { RunBudget, meteredEmbedder } from "./llm/metered";
import type { Llm } from "./llm/types";
import { createOtlpExporter } from "./otel";
import { createConfiguredRouter } from "./router/select";
import { createTools } from "./tools";
import type { Tools } from "./tools";

/** Seams for offline evaluation (eval/); the HTTP entry point below never passes any. */
export interface ServerOverrides {
  /** `null` forces template-only mode; absent means Gemini when GEMINI_API_KEY is set. */
  llm?: Llm | null;
  wrapServing?: (s: ServingDb) => ServingDb;
  wrapTools?: (t: Tools) => Tools;
  /** Clock for JWT issue and verification (ms epoch). */
  authNow?: () => number;
  onDraftRejected?: (draft: string, ruleIds: string[]) => void;
}

export function createServer(env: Record<string, string | undefined> = process.env, o: ServerOverrides = {}) {
  const cfg = loadServerConfig(env);
  const base = openServing(cfg.servingPath);
  const serving = o.wrapServing ? o.wrapServing(base) : base;
  const ops = openOps(cfg.opsPath);
  const auth = createAuth(cfg, serving, ops, o.authNow);
  const llm = o.llm !== undefined ? o.llm : cfg.geminiApiKey ? createGeminiLlm(cfg.geminiApiKey, cfg.geminiModel) : null;
  const ledger = new SpendLedger(cfg.spendLedgerPath, cfg.llmTotalCapUsd);
  // Router embeddings are metered against the same project cap (LLM_TOTAL_CAP_USD); SAFE_MODE disables every model call.
  // The run limit is set to the project cap on purpose: the router is not a chat call and bypasses per-turn and session/daily budgets.
  const embedder =
    cfg.geminiApiKey && !cfg.safeMode
      ? meteredEmbedder(createGeminiEmbedder(cfg.geminiApiKey), new RunBudget(ledger, cfg.llmTotalCapUsd, "server"), "router-embed")
      : null;
  const unavailableReason = !cfg.geminiApiKey ? "no GEMINI_API_KEY" : cfg.safeMode ? "SAFE_MODE disables model calls" : undefined;
  const routing = createConfiguredRouter({
    choice: cfg.router,
    selectionPath: join(ROOT, "ml/models/router-selection.json"),
    modelPath: join(ROOT, "ml/models/router-embed-lr.json"),
    embedder,
    unavailableReason,
  });
  const tools = createTools(serving, ops);
  const sink = cfg.langfuse ? createOtlpExporter({ ...cfg.langfuse, environment: env.DEPLOY_ENV ?? "local" }) : undefined;
  const app = createApp({
    cfg,
    serving,
    ops,
    tools: o.wrapTools ? o.wrapTools(tools) : tools,
    auth,
    router: routing.router,
    llm,
    breaker: new CircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000 }),
    checkpointer: new BunSqliteSaver(ops),
    ledger,
    webDir: cfg.webDir,
    onDraftRejected: o.onDraftRejected,
    sink,
    armor: cfg.modelArmor ? createModelArmor(cfg.modelArmor) : undefined,
  });
  return { cfg, app, llm, ledger, routing, ops, serving, sink };
}

if (import.meta.main) {
  const { cfg, app, llm, ledger, routing, sink } = createServer();
  app.listen(cfg.port);
  process.on("SIGTERM", async () => {
    await sink?.shutdown();
    process.exit(0);
  });
  console.log(
    `AIDO server on :${cfg.port} · model ${llm ? cfg.geminiModel : "none (templates + escalation only)"}${cfg.safeMode ? " · SAFE_MODE" : ""} · router ${routing.router.name} (${routing.reason}) · LLM spend $${ledger.total().toFixed(4)} of $${ledger.capUsd}${sink ? " · traces → Langfuse" : ""}${cfg.modelArmor ? " · Model Armor" : ""}`,
  );
}
