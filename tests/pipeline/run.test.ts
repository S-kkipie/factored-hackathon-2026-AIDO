import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runPipeline } from "../../pipeline/run";
import { makeWorkspace } from "./helpers";

describe("runPipeline", () => {
  test("runs end to end, writes reports and manifest, and is idempotent", async () => {
    const config = await makeWorkspace();
    const first = await runPipeline(config);

    expect(first.stages.map((s) => s.table)).toEqual([
      "customers",
      "products",
      "transactions",
      "complaints",
      "call_center_interactions",
    ]);
    expect(first.personas.normal).toBe("C1");

    const quality = await readFile(join(config.reportsDir, "quality.md"), "utf8");
    expect(quality).toContain(`Run: \`${first.runId}\``);
    expect(await readFile(join(config.reportsDir, "demand.md"), "utf8")).toContain("## contact_mix");

    const manifest = JSON.parse(await readFile(first.manifestPath, "utf8"));
    expect(manifest.runId).toBe(first.runId);
    expect(manifest.inputs.transactions.files).toBe(2);
    expect(manifest.inputs.transactions.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.outputs.serving.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.outputs.serving.customers).toBe(3);

    const second = await runPipeline(config);
    expect(second.stages.every((s) => s.filesLoaded === 0)).toBe(true);
    expect(second.personas).toEqual(first.personas);
  });
});
