import { describe, expect, test } from "bun:test";
import type { Utterance } from "../../ml/dataset";
import { PARAPHRASE_PROMPT_VERSION, generateTrainingSet, paraphrasePrompt } from "../../ml/paraphrase";
import { SpendCapError } from "../../server/llm/metered";
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

  test("a generic error on one family does not lose the others, and the reason is recorded", async () => {
    const llm = fakeLlm((req) => (req.user.includes("boom seed") ? new Error("503 service unavailable") : JSON.stringify({ paraphrases: ["algo nuevo"] })));
    const r = await generateTrainingSet(
      [seed("S1", "f1", "boom seed text"), seed("S2", "f2", "saldo por favor")],
      llm,
      { perFamily: 4, exclude: [], concurrency: 1 },
    );
    expect(r.failedFamilies).toEqual(["f1"]);
    expect(r.failureReasons.f1).toContain("503");
    expect(r.stoppedBySpendCap).toBe(false);
    expect(r.rows.map((u) => u.text)).toContain("algo nuevo");
    expect(r.rows.map((u) => u.text)).toContain("boom seed text");
  });

  test("a SpendCapError stops new families from starting but keeps the ones already done, and is reported", async () => {
    let calls = 0;
    const llm = fakeLlm(() => {
      calls++;
      return calls === 1 ? JSON.stringify({ paraphrases: ["ya generado"] }) : new SpendCapError("run limit of $0.5 reached");
    });
    const r = await generateTrainingSet(
      [seed("S1", "f1", "primero"), seed("S2", "f2", "segundo")],
      llm,
      { perFamily: 2, exclude: [], concurrency: 1 },
    );
    expect(r.stoppedBySpendCap).toBe(true);
    expect(r.failedFamilies).toContain("f2");
    expect(r.failureReasons.f2).toContain("BUD_TOTAL");
    expect(r.rows.map((u) => u.text)).toContain("ya generado");
  });

  test("a cached family is not requested from the model again", async () => {
    const llm = fakeLlm(() => JSON.stringify({ paraphrases: ["nueva paraphrase"] }));
    const cached = new Map<string, string[]>([["f1", ["desde cache"]]]);
    const r = await generateTrainingSet(
      [seed("S1", "f1", "primero"), seed("S2", "f2", "segundo")],
      llm,
      {
        perFamily: 2,
        exclude: [],
        concurrency: 1,
        cache: {
          get: (f) => cached.get(f),
          put: (f, p) => {
            cached.set(f, p);
          },
        },
      },
    );
    expect(llm.requests.length).toBe(1);
    expect(r.cachedFamilies).toBe(1);
    expect(r.rows.map((u) => u.text)).toContain("desde cache");
    expect(r.failedFamilies).toEqual([]);
  });

  test("over-long, too-short and over-count paraphrases are filtered, not a reason to fail the family", async () => {
    const tooLong = "x".repeat(250);
    const tooShort = "a";
    const good = Array.from({ length: 10 }, (_, i) => `frase válida número ${i}`);
    const llm = fakeLlm(() => JSON.stringify({ paraphrases: [tooLong, tooShort, ...good] }));
    const r = await generateTrainingSet([seed("S1", "f1", "semilla")], llm, { perFamily: 4, exclude: [] });
    const generated = r.rows.filter((u) => u.family === "f1" && u.text !== "semilla");
    expect(generated.length).toBe(4 + 5);
    expect(generated.every((u) => u.text.length >= 2 && u.text.length <= 200)).toBe(true);
    expect(r.failedFamilies).toEqual([]);
  });
});
