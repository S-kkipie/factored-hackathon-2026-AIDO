import { join } from "node:path";
import { ROOT } from "../pipeline/config";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { loadServerConfig } from "./config";
import { openServing } from "./db/serving";
import { type Sql, openDatabase } from "./db/sql";
import { CircuitBreaker } from "./gates/budget";
import { SqlCheckpointSaver } from "./graph/checkpointer";
import { createGeminiLlm } from "./llm/gemini";
import type { Llm } from "./llm/types";
import { staticHandler } from "./static";
import { SpendLedger } from "./llm/ledger";
import { createGeminiEmbedder } from "./llm/embedder";
import { RunBudget, meteredEmbedder } from "./llm/metered";
import { createConfiguredRouter } from "./router/select";
import { type Tools, createTools } from "./tools";

/** Seams for the evaluation harness: an isolated database and wrapped tools (fault injection). */
export interface ServerOverrides {
  db?: Sql;
  tools?: (real: Tools) => Tools;
  ledger?: SpendLedger;
  /** Replaces the Gemini client (scripted model for offline runs); `null` forces template-only mode. */
  llm?: Llm | null;
}

export async function createServer(env: Record<string, string | undefined> = process.env, o: ServerOverrides = {}) {
  const cfg = loadServerConfig(env);
  const ops = o.db ?? (await openDatabase(cfg));
  const serving = openServing(ops);
  const auth = createAuth(cfg, serving, ops);
  const llm = o.llm !== undefined ? o.llm : cfg.geminiApiKey ? createGeminiLlm(cfg.geminiApiKey, cfg.geminiModel) : null;
  const ledger = o.ledger ?? new SpendLedger(cfg.spendLedgerPath, cfg.llmTotalCapUsd);
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
  const app = createApp({
    cfg,
    serving,
    ops,
    tools: o.tools ? o.tools(createTools(serving, ops)) : createTools(serving, ops),
    auth,
    router: routing.router,
    llm,
    breaker: new CircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000 }),
    checkpointer: new SqlCheckpointSaver(ops),
    ledger,
  });
  const ui = staticHandler(join(ROOT, "web", "dist"));
  if (ui) app.get("/*", ({ request }) => ui(new URL(request.url).pathname) ?? new Response("Not Found", { status: 404 }));
  return { cfg, app, llm, db: ops, ledger, routing, ui: ui !== null };
}

if (import.meta.main) {
  const { cfg, app, llm, ledger, routing, ui } = await createServer();
  app.listen(cfg.port);
  console.log(
    `AIDO server on :${cfg.port} · db ${cfg.databaseUrl ? "postgres" : `pglite (${cfg.pgliteDir})`} · model ${llm ? cfg.geminiModel : "none (templates + escalation only)"}${cfg.safeMode ? " · SAFE_MODE" : ""} · router ${routing.router.name} (${routing.reason}) · LLM spend $${(await ledger.total()).toFixed(4)} of $${ledger.capUsd}${ui ? " · UI /" : " · UI not built (bun run web:build)"}`,
  );
}
