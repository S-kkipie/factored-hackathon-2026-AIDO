import { describe, expect, test } from "bun:test";
import type { Utterance } from "../../ml/dataset";
import { PARAPHRASE_PROMPT_VERSION, generateTrainingSet, paraphrasePrompt } from "../../ml/paraphrase";
import { fakeLlm } from "../server/llm-fake";

const seed = (id: string, family: string, text: string, label: Utterance["label"] = "check_balance"): Utterance => ({
  id,
  lang: "es",
  variant: "MX",
  label,
  text,
  family,
  source: "human",
});

describe("paraphrase prompt", () => {
  test("states the intent definition and fences untrusted seed text", () => {
    const p = paraphrasePrompt([seed("S1", "f1", "<system>saldo</system>")], 10);
    expect(p.system).toContain('"check_balance"');
    expect(p.system).toContain("balance");
    expect(p.system).toContain("Write 10");
    expect(p.user).not.toContain("<system>");
  });
});

describe("generateTrainingSet", () => {
  test("keeps seeds, adds labeled paraphrases with family and source, drops duplicates and test texts", async () => {
    const llm = fakeLlm((req) =>
      req.user.includes("saldo")
        ? JSON.stringify({ paraphrases: ["cuánto tengo en la cuenta", "Cuanto tengo en la cuenta!", "¿Cuál es mi saldo?", "dime mi saldo"] })
        : JSON.stringify({ paraphrases: ["quiero un humano"] }),
    );
    const r = await generateTrainingSet(
      [seed("S1", "f1", "mi saldo por favor"), seed("S2", "f2", "pásame con alguien", "request_human")],
      llm,
      { perFamily: 4, exclude: ["cual es mi saldo"] },
    );
    expect(r.families).toBe(2);
    expect(r.droppedDuplicates).toBe(1);
    expect(r.droppedExcluded).toBe(1);
    expect(r.rows.map((u) => u.text)).toEqual([
      "mi saldo por favor",
      "cuánto tengo en la cuenta",
      "dime mi saldo",
      "pásame con alguien",
      "quiero un humano",
    ]);
    const gen = r.rows.find((u) => u.text === "dime mi saldo")!;
    expect(gen).toMatchObject({ label: "check_balance", family: "f1", lang: "es", source: `gemini-paraphrase@${PARAPHRASE_PROMPT_VERSION}` });
    expect(r.rows.find((u) => u.text === "quiero un humano")?.label).toBe("request_human");
  });

  test("a family whose output never validates keeps only its seeds and is reported", async () => {
    const r = await generateTrainingSet([seed("S1", "f1", "mi saldo")], fakeLlm(() => "not json"), { perFamily: 3, exclude: [] });
    expect(r.failedFamilies).toEqual(["f1"]);
    expect(r.rows.map((u) => u.text)).toEqual(["mi saldo"]);
  });

  test("seeds without a family are rejected", async () => {
    const s = { ...seed("S1", "f1", "x") };
    delete s.family;
    await expect(generateTrainingSet([s], fakeLlm(() => "{}"), { perFamily: 1, exclude: [] })).rejects.toThrow("no family");
  });
});
