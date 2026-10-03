import { createApp } from "./app";
import { createAuth } from "./auth";
import { loadServerConfig } from "./config";
import { openOps } from "./db/ops";
import { openServing } from "./db/serving";
import { CircuitBreaker } from "./gates/budget";
import { BunSqliteSaver } from "./graph/checkpointer";
import { createGeminiLlm } from "./llm/gemini";
import { SpendLedger } from "./llm/ledger";
import { createKeywordRouter } from "./router/keyword";
import { createTools } from "./tools";

export function createServer(env: Record<string, string | undefined> = process.env) {
  const cfg = loadServerConfig(env);
  const serving = openServing(cfg.servingPath);
  const ops = openOps(cfg.opsPath);
  const auth = createAuth(cfg, serving, ops);
  const llm = cfg.geminiApiKey ? createGeminiLlm(cfg.geminiApiKey, cfg.geminiModel) : null;
  const ledger = new SpendLedger(cfg.spendLedgerPath, cfg.llmTotalCapUsd);
  const app = createApp({
    cfg,
    serving,
    ops,
    tools: createTools(serving, ops),
    auth,
    router: createKeywordRouter(),
    llm,
    breaker: new CircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000 }),
    checkpointer: new BunSqliteSaver(ops),
    ledger,
  });
  return { cfg, app, llm, ledger };
}

if (import.meta.main) {
  const { cfg, app, llm, ledger } = createServer();
  app.listen(cfg.port);
  console.log(
    `AIDO server on :${cfg.port} · model ${llm ? cfg.geminiModel : "none (templates + escalation only)"}${cfg.safeMode ? " · SAFE_MODE" : ""} · LLM spend $${ledger.total().toFixed(4)} of $${ledger.capUsd}`,
  );
}
