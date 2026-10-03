import { GoogleGenAI, HarmBlockThreshold, HarmCategory, ThinkingLevel } from "@google/genai";
import type { Llm } from "./types";

/**
 * Gemini client with explicit safety settings: BLOCK_NONE so the provider returns scores instead of silently
 * dropping banking text (spec 4.5); our own gates decide. Temperature 0 and low thinking for repeatable extraction.
 */
export function createGeminiLlm(apiKey: string, model: string): Llm {
  const ai = new GoogleGenAI({ apiKey });
  const safetySettings = [
    HarmCategory.HARM_CATEGORY_HARASSMENT,
    HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
  ].map((category) => ({ category, threshold: HarmBlockThreshold.BLOCK_NONE }));

  return {
    model,
    async generate(req) {
      const res = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: req.user }] }],
        config: {
          systemInstruction: req.system,
          temperature: 0,
          maxOutputTokens: req.maxOutputTokens,
          responseMimeType: req.json ? "application/json" : "text/plain",
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          safetySettings,
          abortSignal: req.signal,
        },
      });
      const usage = res.usageMetadata;
      return {
        text: res.text ?? "",
        model,
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
      };
    },
  };
}
