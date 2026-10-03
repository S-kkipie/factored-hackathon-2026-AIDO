import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfiguredRouter } from "../../server/router/select";
import { fakeEmbedder } from "./fakes";

function files(selection?: unknown, model?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "aido-sel-"));
  const selectionPath = join(dir, "selection.json");
  const modelPath = join(dir, "model.json");
  if (selection !== undefined) writeFileSync(selectionPath, JSON.stringify(selection));
  if (model !== undefined) writeFileSync(modelPath, JSON.stringify(model));
  return { selectionPath, modelPath };
}

const model = (dim: number) => ({
  version: "1",
  labels: ["greeting", "check_balance"],
  dim,
  weights: [new Array(dim).fill(0), new Array(dim).fill(0)],
  bias: [0, 0],
  temperature: 1,
});

describe("runtime router selection", () => {
  test("auto without a selection file uses the keyword baseline", () => {
    const r = createConfiguredRouter({ choice: "auto", ...files(), embedder: fakeEmbedder(8) });
    expect(r.router.name).toBe("keyword-v1");
    expect(r.reason).toContain("no router selection");
  });

  test("auto follows the experiment's selection", () => {
    const r = createConfiguredRouter({ choice: "auto", ...files({ router: "embed-lr", runId: "run-1" }, model(8)), embedder: fakeEmbedder(8) });
    expect(r.router.name).toBe("embed-lr@1");
    expect(r.reason).toContain("run-1");
  });

  test("embed-lr falls back to keyword without an API key or a model file", () => {
    expect(createConfiguredRouter({ choice: "embed-lr", ...files(undefined, model(8)), embedder: null }).router.name).toBe("keyword-v1");
    expect(createConfiguredRouter({ choice: "embed-lr", ...files(), embedder: fakeEmbedder(8) }).reason).toContain("model file missing");
  });

  test("an unknown selection or a corrupt model fails loudly", () => {
    expect(() => createConfiguredRouter({ choice: "auto", ...files({ router: "gemini-zeroshot" }), embedder: null })).toThrow("unknown selected router");
    expect(() => createConfiguredRouter({ choice: "embed-lr", ...files(undefined, { bad: 1 }), embedder: fakeEmbedder(8) })).toThrow("schema");
  });
});
