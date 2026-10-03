import { createApp } from "./app";
import { createAuth } from "./auth";
import { loadServerConfig } from "./config";
import { openServing } from "./db/serving";
import { openDatabase } from "./db/sql";
import { CircuitBreaker } from "./gates/budget";
import { SqlCheckpointSaver } from "./graph/checkpointer";
import { createGeminiLlm } from "./llm/gemini";
import { createKeywordRouter } from "./router/keyword";
import { createTools } from "./tools";

export async function createServer(env: Record<string, string | undefined> = process.env) {
  const cfg = loadServerConfig(env);
  const ops = await openDatabase(cfg);
  const serving = openServing(ops);
  const auth = createAuth(cfg, serving, ops);
  const llm = cfg.geminiApiKey ? createGeminiLlm(cfg.geminiApiKey, cfg.geminiModel) : null;
  const app = createApp({
    cfg,
    serving,
    ops,
    tools: createTools(serving, ops),
    auth,
    router: createKeywordRouter(),
    llm,
    breaker: new CircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000 }),
    checkpointer: new SqlCheckpointSaver(ops),
  });
  return { cfg, app, llm, db: ops };
}

if (import.meta.main) {
  const { cfg, app, llm } = await createServer();
  app.listen(cfg.port);
  console.log(
    `AIDO server on :${cfg.port} · db ${cfg.databaseUrl ? "postgres" : `pglite (${cfg.pgliteDir})`} · model ${llm ? cfg.geminiModel : "none (templates + escalation only)"}${cfg.safeMode ? " · SAFE_MODE" : ""}`,
  );
}
