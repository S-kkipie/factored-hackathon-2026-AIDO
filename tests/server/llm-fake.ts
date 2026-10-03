import type { Llm, LlmRequest } from "../../server/llm/types";

export type Script = (req: LlmRequest, call: number) => string | Error | Promise<string>;

/** Scripted model for tests: records every request and answers from `script`. */
export function fakeLlm(script: Script, model = "gemini-3.8-flash"): Llm & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    model,
    requests,
    async generate(req) {
      requests.push(req);
      const out = await script(req, requests.length);
      if (out instanceof Error) throw out;
      return { text: out, model, inputTokens: 100, outputTokens: 20 };
    },
  };
}

/** Answers extract_slots with `slots` and respond with `reply`, keyed by the system prompt. */
export const byPurpose = (slots: unknown, reply: string): Script => (req) =>
  req.system.startsWith("You extract") ? JSON.stringify(slots) : JSON.stringify({ reply });
