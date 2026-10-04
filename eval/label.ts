import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../pipeline/config";
import type { JudgeItem } from "./judge";

export type Label = { grounded: boolean; language: boolean; tone: boolean; pass: boolean; note?: string };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Localhost-only labeling page (spec 7: human labels for the judge). Items are shown in the sample's blind order
 * with no system name and no judge verdict. Labels are saved by item key to `labelsPath` after every click.
 */
export function createLabelApp(o: { items: JudgeItem[]; sampleKeys: string[]; labelsPath: string }) {
  const sample = o.sampleKeys.map((k) => o.items.find((i) => i.key === k)).filter((i): i is JudgeItem => Boolean(i));
  const load = (): Record<string, Label> => (existsSync(o.labelsPath) ? JSON.parse(readFileSync(o.labelsPath, "utf8")) : {});

  function page(): string {
    const labels = load();
    const cards = sample
      .map((item, index) => {
        const e = item.evidence;
        const l = labels[item.key];
        const box = (c: "grounded" | "language" | "tone") =>
          `<label><input type="checkbox" data-c="${c}"${l?.[c] ? " checked" : ""}> ${c}</label>`;
        return `<section class="item${l ? " done" : ""}" data-index="${index}">
  <h2>#${index + 1} · ${e.language.toUpperCase()}</h2>
  <p class="k">Customer</p><pre>${esc(e.userMessages.join("\n"))}</pre>
  <p class="k">Reply</p><pre class="reply">${esc(e.reply)}</pre>
  <details><summary>Bank records (evidence)</summary><pre>${esc(JSON.stringify({ products: e.products, transactions: e.transactions }, null, 1))}</pre></details>
  <div class="row">${box("grounded")}${box("language")}${box("tone")}<button data-save>Save</button><span class="st">${l ? (l.pass ? "saved: PASS" : "saved: FAIL") : ""}</span></div>
</section>`;
      })
      .join("\n");
    const done = sample.filter((i) => labels[i.key]).length;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Label replies</title>
<style>body{font:15px/1.5 system-ui;max-width:860px;margin:24px auto;padding:0 16px;background:#f7f5ef;color:#10231e}
.item{background:#fff;border:1px solid #e6e1d3;border-radius:12px;padding:12px 16px;margin:12px 0}.done{border-color:#0b5d4b}
pre{white-space:pre-wrap;background:#f3f0e7;padding:8px;border-radius:8px}.reply{background:#e3efe9}.k{margin:8px 0 2px;font-weight:600}
.row{display:flex;gap:16px;align-items:center}button{background:#0b5d4b;color:#fff;border:0;border-radius:8px;padding:6px 14px}</style></head>
<body><h1>Label ${sample.length} replies (${done} done)</h1>
<p>Check a box when the reply passes that criterion. <b>grounded</b>: every amount/id/date/merchant/status is in the bank records (or the reply states no facts). <b>language</b>: in the conversation's language. <b>tone</b>: polite, concise, no improvised promises, never asks for passwords or card numbers. Pass = all three.</p>
${cards}
<script>
document.querySelectorAll("[data-save]").forEach((b) => b.addEventListener("click", async () => {
  const s = b.closest(".item"); const v = (c) => s.querySelector('[data-c="' + c + '"]').checked;
  const r = await fetch("/api/label", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ index: Number(s.dataset.index), grounded: v("grounded"), language: v("language"), tone: v("tone") }) });
  s.querySelector(".st").textContent = r.ok ? (v("grounded") && v("language") && v("tone") ? "saved: PASS" : "saved: FAIL") : "error";
  if (r.ok) s.classList.add("done");
}));
</script></body></html>`;
  }

  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/") return new Response(page(), { headers: { "content-type": "text/html; charset=utf-8" } });
      if (req.method === "POST" && url.pathname === "/api/label") {
        const body = (await req.json().catch(() => null)) as { index?: unknown; grounded?: unknown; language?: unknown; tone?: unknown } | null;
        const item = typeof body?.index === "number" ? sample[body.index] : undefined;
        if (!item || typeof body!.grounded !== "boolean" || typeof body!.language !== "boolean" || typeof body!.tone !== "boolean") {
          return new Response("bad label", { status: 400 });
        }
        const labels = load();
        const g = body!.grounded as boolean;
        const l = body!.language as boolean;
        const t = body!.tone as boolean;
        labels[item.key] = { grounded: g, language: l, tone: t, pass: g && l && t };
        writeFileSync(o.labelsPath, JSON.stringify(labels, null, 1));
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  };
}

if (import.meta.main) {
  const dir = join(ROOT, "data/eval/judge");
  const { items } = JSON.parse(readFileSync(join(dir, "items.json"), "utf8")) as { items: JudgeItem[] };
  const sampleKeys = JSON.parse(readFileSync(join(dir, "sample.json"), "utf8")) as string[];
  const app = createLabelApp({ items, sampleKeys, labelsPath: join(dir, "labels.json") });
  Bun.serve({ hostname: "127.0.0.1", port: 5174, fetch: app.fetch });
  console.log("labeling page: http://127.0.0.1:5174 (labels → data/eval/judge/labels.json)");
}
