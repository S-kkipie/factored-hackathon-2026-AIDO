import { existsSync, readFileSync } from "node:fs";
import type { Embedder } from "../llm/embedder";
import { createEmbeddingRouter, parseLogRegModel } from "./embedding";
import { createKeywordRouter } from "./keyword";
import type { Router } from "./types";

export type RouterChoice = "auto" | "keyword" | "embed-lr";

export interface RouterSetup {
  /** `ROUTER` env: auto (use the experiment's selection), keyword or embed-lr. */
  choice: RouterChoice;
  selectionPath: string;
  modelPath: string;
  /** Metered embedder, or null when there is no model API key. */
  embedder: Embedder | null;
  /** Why the embedder is unavailable (e.g., "SAFE_MODE disables model calls" or "no GEMINI_API_KEY"). */
  unavailableReason?: string;
}

/**
 * Picks the runtime router. `auto` follows ml/models/router-selection.json written by `bun run train`; any missing
 * piece (selection file, model file, API key) falls back to the keyword baseline, and the reason is returned.
 */
export function createConfiguredRouter(s: RouterSetup): { router: Router; reason: string } {
  let want: "keyword" | "embed-lr" = s.choice === "auto" ? "keyword" : s.choice;
  let reason = `ROUTER=${s.choice}`;
  if (s.choice === "auto") {
    if (!existsSync(s.selectionPath)) return { router: createKeywordRouter(), reason: "no router selection file; keyword baseline" };
    const sel = JSON.parse(readFileSync(s.selectionPath, "utf8")) as { router?: string; runId?: string };
    if (sel.router !== "keyword" && sel.router !== "embed-lr") throw new Error(`unknown selected router '${String(sel.router)}'`);
    want = sel.router;
    reason = `selected by experiment ${sel.runId ?? "unknown"}`;
  }
  if (want === "keyword") return { router: createKeywordRouter(), reason };
  if (!s.embedder) return { router: createKeywordRouter(), reason: `${reason}; embed-lr unavailable (${s.unavailableReason ?? "no embedder"}); keyword baseline` };
  if (!existsSync(s.modelPath)) return { router: createKeywordRouter(), reason: `${reason}; embed-lr model file missing; keyword baseline` };
  const raw = JSON.parse(readFileSync(s.modelPath, "utf8")) as { version?: string };
  return { router: createEmbeddingRouter(s.embedder, parseLogRegModel(raw), raw.version ?? "unknown"), reason };
}
