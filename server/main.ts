import { join } from "node:path";
import { ROOT } from "../pipeline/config";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { loadServerConfig } from "./config";
import { openOps } from "./db/ops";
import { openServing } from "./db/serving";
import { CircuitBreaker } from "./gates/budget";
import { BunSqliteSaver } from "./graph/checkpointer";
import { createGeminiLlm } from "./llm/gemini";
import { SpendLedger } from "./llm/ledger";
import { createGeminiEmbedder } from "./llm/embedder";
import { RunBudget, meteredEmbedder } from "./llm/metered";
import { createConfiguredRouter } from "./router/select";
import { createTools } from "./tools";

export function createServer(env: Record<string, string | undefined> = process.env) {
  const cfg = loadServerConfig(env);
  const serving = openServing(cfg.servingPath);
  const ops = openOps(cfg.opsPath);
  const auth = createAuth(cfg, serving, ops);
  const llm = cfg.geminiApiKey ? createGeminiLlm(cfg.geminiApiKey, cfg.geminiModel) : null;
  const ledger = new SpendLedger(cfg.spendLedgerPath, cfg.llmTotalCapUsd);
  // Router embeddings are metered against the same project cap; SAFE_MODE disables every model call.
  const embedder =
    cfg.geminiApiKey && !cfg.safeMode
      ? meteredEmbedder(createGeminiEmbedder(cfg.geminiApiKey), new RunBudget(ledger, cfg.llmTotalCapUsd, "server"), "router-embed")
      : null;
  const routing = createConfiguredRouter({
    choice: cfg.router,
    selectionPath: join(ROOT, "ml/models/router-selection.json"),
    modelPath: join(ROOT, "ml/models/router-embed-lr.json"),
    embedder,
  });
  const app = createApp({
    cfg,
    serving,
    ops,
    tools: createTools(serving, ops),
    auth,
    router: routing.router,
    llm,
    breaker: new CircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000 }),
    checkpointer: new BunSqliteSaver(ops),
    ledger,
  });
  return { cfg, app, llm, ledger, routing };
}

if (import.meta.main) {
  const { cfg, app, llm, ledger, routing } = createServer();
  app.listen(cfg.port);
  console.log(
    `AIDO server on :${cfg.port} · model ${llm ? cfg.geminiModel : "none (templates + escalation only)"}${cfg.safeMode ? " · SAFE_MODE" : ""} · router ${routing.router.name} (${routing.reason}) · LLM spend $${ledger.total().toFixed(4)} of $${ledger.capUsd}`,
  );
}
