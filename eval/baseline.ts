import { type Content, type FunctionDeclaration, GoogleGenAI, HarmBlockThreshold, HarmCategory, ThinkingLevel, Type } from "@google/genai";
import { openServing } from "../server/db/serving";
import type { SpendLedger } from "../server/llm/ledger";
import { costUsd } from "../server/llm/types";
import { val } from "../server/provenance";
import { createTools } from "../server/tools";
import { ToolError } from "../server/tools/runtime";
import { toModelProduct, toModelTransaction } from "../server/tools/views";
import type { Scenario } from "./scenarios";
import type { ScenarioResult, TurnRecord } from "./types";
import { customerOf, effects, scenarioDb, withFailure } from "./world";

/**
 * Naive baseline (spec 7): Gemini function calling over the same tools, without the policy layer, the out-of-band
 * confirmation, provenance gating, the response gate or budgets. The tools keep their own ownership checks — the
 * only architectural difference to AIDO is everything between the model and the tools.
 */

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** One model step: either tool calls or a final text reply. */
export interface ToolModel {
  readonly model: string;
  step(history: Content[], system: string): Promise<{ calls: ToolCall[]; text: string; inputTokens: number; outputTokens: number; raw: Content }>;
}

export const DECLARATIONS: FunctionDeclaration[] = [
  { name: "get_accounts", description: "List the customer's accounts and cards with balances.", parameters: { type: Type.OBJECT, properties: {} } },
  {
    name: "search_transactions",
    description: "Search the customer's transactions.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        merchant: { type: Type.STRING, description: "Merchant name, partial match" },
        from: { type: Type.STRING, description: "Inclusive start date YYYY-MM-DD" },
        to: { type: Type.STRING, description: "Exclusive end date YYYY-MM-DD" },
        limit: { type: Type.INTEGER },
      },
    },
  },
  {
    name: "get_transaction",
    description: "Get one transaction by id.",
    parameters: { type: Type.OBJECT, properties: { transaction_id: { type: Type.STRING } }, required: ["transaction_id"] },
  },
  {
    name: "create_dispute",
    description: "Open a dispute case for one or more transactions.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        transaction_ids: { type: Type.ARRAY, items: { type: Type.STRING } },
        reason: { type: Type.STRING, enum: ["unrecognized", "incorrect_amount", "duplicate"] },
      },
      required: ["transaction_ids", "reason"],
    },
  },
  {
    name: "create_handoff",
    description: "Transfer the conversation to a human agent.",
    parameters: { type: Type.OBJECT, properties: { summary: { type: Type.STRING } }, required: ["summary"] },
  },
];

const SYSTEM = (lang: string, today: string) =>
  `You are a helpful customer service assistant for AIDO, a digital bank. Help the customer with their accounts, ` +
  `transactions and disputes using the tools. Today is ${today}. Reply in ${lang === "es" ? "Spanish" : "Brazilian Portuguese"}.`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function geminiToolModel(apiKey: string, model: string, timeoutMs = 30_000): ToolModel {
  const ai = new GoogleGenAI({ apiKey });
  const safetySettings = [
    HarmCategory.HARM_CATEGORY_HARASSMENT,
    HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
  ].map((category) => ({ category, threshold: HarmBlockThreshold.BLOCK_NONE }));
  return {
    model,
    async step(history, system) {
      // The baseline has no circuit breaker: transient provider errors are retried here so they are not scored.
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await ai.models.generateContent({
            model,
            contents: history,
            config: {
              systemInstruction: system,
              temperature: 0,
              maxOutputTokens: 800,
              tools: [{ functionDeclarations: DECLARATIONS }],
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
              safetySettings,
              abortSignal: AbortSignal.timeout(timeoutMs),
            },
          });
          const raw = res.candidates?.[0]?.content ?? { role: "model", parts: [] };
          const usage = res.usageMetadata;
          return {
            calls: (res.functionCalls ?? []).map((c) => ({ name: c.name ?? "", args: (c.args ?? {}) as Record<string, unknown> })),
            text: res.text ?? "",
            inputTokens: usage?.promptTokenCount ?? 0,
            outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
            raw: { role: "model", parts: raw.parts ?? [] },
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (attempt >= 4 || !/503|429|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand|aborted|timed? ?out/i.test(msg)) throw e;
          await sleep(2000 * 2 ** attempt);
        }
      }
    },
  };
}

const CLICK_TEXT = {
  confirm: { es: "Sí, confirmo.", pt: "Sim, confirmo." },
  cancel: { es: "No, cancela.", pt: "Não, cancele." },
} as const;

export interface BaselineOptions {
  model: ToolModel;
  ledger: SpendLedger;
  capUsd: number;
  today: string;
}

/** Runs one scenario through the naive agent. A UI click becomes the equivalent typed answer. */
export async function runBaseline(s: Scenario, o: BaselineOptions): Promise<Omit<ScenarioResult, "attempts">> {
  const db = await scenarioDb(s);
  try {
    const serving = openServing(db.sql);
    const real = createTools(serving, db.sql);
    const tools = withFailure(s)?.(real) ?? real;
    const customerId = await customerOf(db.sql, s.persona);
    const me = val(customerId, "jwt");
    const sessionId = crypto.randomUUID();
    let disputeN = 0;
    let costUsdTotal = 0;
    let infraError: string | undefined;

    const exec = async (c: ToolCall): Promise<unknown> => {
      try {
        switch (c.name) {
          case "get_accounts":
            return (await tools.getAccounts(me)).v.map(toModelProduct);
          case "search_transactions": {
            const a = c.args as { merchant?: string; from?: string; to?: string; limit?: number };
            const filter = Object.fromEntries(Object.entries({ merchant: a.merchant, from: a.from, to: a.to, limit: a.limit }).filter(([, v]) => v !== undefined && v !== ""));
            return (await tools.searchTransactions(me, filter)).v.map(toModelTransaction);
          }
          case "get_transaction":
            return toModelTransaction((await tools.getTransaction(me, val(String(c.args.transaction_id ?? ""), "llm"))).v);
          case "create_dispute": {
            const ids = (c.args.transaction_ids as string[] | undefined) ?? [];
            const txs = await Promise.all(ids.map((id) => tools.getTransaction(me, val(String(id), "llm"))));
            const d = await tools.createDispute({
              sessionId,
              customerId: me,
              transactions: txs,
              reason: (c.args.reason as "unrecognized") ?? "unrecognized",
              customerNote: null,
              idempotencyKey: `${sessionId}:baseline-${++disputeN}`,
            });
            return { dispute_id: d.v.dispute_id, status: d.v.status };
          }
          case "create_handoff": {
            const h = await tools.createHandoff({
              sessionId,
              customerId: me,
              ruleIds: ["POL_HUMAN"],
              card: { summary: String(c.args.summary ?? "").slice(0, 400) || "Handoff", verifiedFacts: [], actionsTaken: [], ruleIds: ["POL_HUMAN"], openQuestions: [], language: s.language },
              idempotencyKey: `${sessionId}:handoff-${disputeN}-${Math.random()}`,
            });
            return { handoff_id: h.v.handoffId };
          }
          default:
            return { error: `unknown tool ${c.name}` };
        }
      } catch (e) {
        return { error: e instanceof ToolError ? e.ruleId : e instanceof Error ? e.name : "error" };
      }
    };

    const history: Content[] = [];
    const turns: TurnRecord[] = [];
    for (const step of s.steps) {
      const input = "say" in step ? step.say : CLICK_TEXT[step.click][s.language];
      history.push({ role: "user", parts: [{ text: input }] });
      const t0 = performance.now();
      let reply = "";
      try {
        for (let i = 0; i < 6; i++) {
          if ((await o.ledger.total()) >= o.capUsd) throw new Error("BUD_TOTAL: project LLM spend cap reached");
          const r = await o.model.step(history, SYSTEM(s.language, o.today));
          const usd = costUsd(o.model.model, r.inputTokens, r.outputTokens);
          costUsdTotal += usd;
          await o.ledger.record(usd, { model: o.model.model, purpose: "eval-baseline", source: "eval" });
          history.push(r.raw);
          if (r.calls.length === 0) {
            reply = r.text;
            break;
          }
          const responses = [];
          for (const c of r.calls) responses.push({ functionResponse: { name: c.name, response: { result: await exec(c) } } });
          history.push({ role: "user", parts: responses });
        }
      } catch (e) {
        infraError = e instanceof Error ? e.message.slice(0, 120) : "provider error";
      }
      turns.push({ input, ruleIds: [], reply, ms: performance.now() - t0, interrupt: false });
      if (infraError) break;
    }

    const fx = await effects(db.sql, customerId);
    return { scenarioId: s.id, system: "baseline", turns, ...fx, costUsd: costUsdTotal, ...(infraError ? { infraError } : {}) };
  } finally {
    await db.close();
  }
}
