import type { Language } from "../auth";
import type { Intent } from "../policy/rules";

/** What a router may answer: a policy intent, or a greeting/thanks that is answered from a template. */
export type RouteLabel = Intent | "greeting";

export interface RouteResult {
  label: RouteLabel;
  /** Calibrated confidence in [0, 1]; below the routing threshold the graph clarifies. */
  confidence: number;
  router: string;
  /** This router's own dev-chosen threshold (ml/train.ts); falls back to POLICY.routerThreshold when absent. */
  threshold?: number;
}

/** One interface for every router compared in plan 3 (keyword, Gemini zero-shot, embeddings + LR, Jev). */
export interface Router {
  readonly name: string;
  route(text: string, language: Language): Promise<RouteResult>;
}
