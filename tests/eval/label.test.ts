import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JudgeItem } from "../../eval/judge";
import { createLabelApp } from "../../eval/label";

const item = (key: string, reply: string): JudgeItem => ({
  key, system: "proposed", scenarioId: key, category: "normal",
  evidence: { language: "es", userMessages: ["hola <script>"], reply, products: [], transactions: [] },
});

test("the labeling page escapes text, hides system names, and saves labels", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "lbl-")), "labels.json");
  const app = createLabelApp({ items: [item("proposed:a", "<img src=x onerror=alert(1)>"), item("baseline:b", "ok")], sampleKeys: ["proposed:a", "baseline:b"], labelsPath: path });
  const html = await (await app.fetch(new Request("http://127.0.0.1/"))).text();
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  expect(html).not.toContain("<img src=x");
  expect(html).not.toContain("proposed");
  expect(html).not.toContain("baseline");
  const res = await app.fetch(
    new Request("http://127.0.0.1/api/label", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ index: 0, grounded: true, language: true, tone: false }),
    }),
  );
  expect(res.status).toBe(200);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ "proposed:a": { grounded: true, language: true, tone: false, pass: false } });
  const bad = await app.fetch(new Request("http://127.0.0.1/api/label", { method: "POST", body: JSON.stringify({ index: 9, grounded: true, language: true, tone: true }) }));
  expect(bad.status).toBe(400);
});
