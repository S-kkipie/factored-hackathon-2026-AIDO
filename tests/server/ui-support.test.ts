import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../server/app";
import { webHandler } from "../../server/static";
import { listSpans } from "../../server/trace";
import { harness } from "./graph-harness";
import { byPurpose } from "./llm-fake";

type Ev = { type: string; [k: string]: unknown };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeDist(): string {
  const root = mkdtempSync(join(tmpdir(), "aido-web-"));
  dirs.push(root);
  const dist = join(root, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>AIDO</title>");
  writeFileSync(join(dist, "assets", "app.js"), "console.log(1)");
  writeFileSync(join(root, "secret.txt"), "top-secret");
  return dist;
}

async function setup(webDir?: string) {
  const h = await harness({ script: byPurpose({ merchant: "Super Ahorro", amount: 45, reason: "unrecognized" }, "x") });
  const app = createApp({ ...h.deps, auth: h.auth, webDir });
  const call = (path: string, init: RequestInit = {}, token?: string) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      }),
    );
  const login = async () =>
    (await (await call("/api/auth/login", { method: "POST", body: JSON.stringify({ persona: "normal", pin: "2468", language: "es" }) })).json()) as {
      token: string;
      sessionId: string;
    };
  const run = async (token: string, threadId: string, body: Record<string, unknown>) => {
    const res = await call("/api/agui/run", { method: "POST", body: JSON.stringify({ threadId, runId: crypto.randomUUID(), messages: [], ...body }) }, token);
    const text = await res.text();
    return text
      .split("\n\n")
      .filter((b) => b.startsWith("data: "))
      .map((b) => JSON.parse(b.slice(6)) as Ev);
  };
  return { h, call, login, run };
}

const say = (text: string) => ({ messages: [{ id: "m1", role: "user", content: text }] });
const deltaValue = (events: Ev[], path: string) =>
  events
    .filter((e) => e.type === "STATE_DELTA")
    .flatMap((e) => e.delta as { path: string; value: unknown }[])
    .find((op) => op.path === path)?.value;

describe("webHandler", () => {
  test("is null when there is no build", () => {
    expect(webHandler(join(tmpdir(), `no-build-${crypto.randomUUID()}`))).toBeNull();
  });

  test("serves files, falls back to index.html for app routes, refuses api paths and traversal", async () => {
    const serve = webHandler(makeDist())!;
    const asset = serve("/assets/app.js")!;
    expect(await asset.text()).toBe("console.log(1)");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    const page = serve("/trace/abc")!;
    expect(await page.text()).toContain("<title>AIDO</title>");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(serve("/api/anything")).toBeNull();
    expect(serve("/api")).toBeNull();
    expect(serve("/missing.js")!.status).toBe(404);
    for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt", "/%E0%A4%A"]) {
      const r = serve(p);
      expect(r === null || !(await r.text()).includes("top-secret")).toBe(true);
    }
  });
});

describe("app routes for the UI", () => {
  test("GET /api/session describes the caller's session", async () => {
    const { call, login } = await setup();
    const s = await login();
    const res = await call("/api/session", {}, s.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ sessionId: s.sessionId, role: "customer", language: "es", status: "active" });
    expect(typeof body.expiresAt).toBe("number");
    expect(JSON.stringify(body)).not.toContain("CLI-");
    expect((await call("/api/session")).status).toBe(401);
  });

  test("the built web app is served beside the API; unknown API paths stay 404 JSON", async () => {
    const { call } = await setup(makeDist());
    const page = await call("/chat");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>AIDO</title>");
    const missing = await call("/api/nope");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
    expect((await call("/api/health")).status).toBe(200);
  });

  test("without a build, app routes are 404", async () => {
    const { call } = await setup();
    expect((await call("/chat")).status).toBe(404);
  });
});

describe("turn state for the UI", () => {
  test("a created dispute reports its case id in the final state delta", async () => {
    const { login, run } = await setup();
    const s = await login();
    const first = await run(s.token, s.sessionId, say("No reconozco un cargo de 45 dólares en Super Ahorro"));
    const it = (first.at(-1)?.outcome as { interrupts: { id: string; metadata: { nonce: string } }[] }).interrupts[0]!;
    expect(deltaValue(first, "/caseId")).toBeUndefined();
    const done = await run(s.token, s.sessionId, {
      resume: [{ interruptId: it.id, status: "resolved", payload: { nonce: it.metadata.nonce, approved: true } }],
    });
    expect(String(deltaValue(done, "/caseId"))).toMatch(/^D-/);
    expect(deltaValue(done, "/outcome")).toBe("dispute_created");
  });

  test("a handoff reports its handoff id", async () => {
    const { login, run } = await setup();
    const s = await login();
    const events = await run(s.token, s.sessionId, say("Quiero hablar con un agente"));
    expect(deltaValue(events, "/outcome")).toBe("handoff");
    expect(typeof deltaValue(events, "/handoffId")).toBe("string");
  });

  test("the router span records label, confidence and router name", async () => {
    const { h, login, run } = await setup();
    const s = await login();
    await run(s.token, s.sessionId, say("No reconozco un cargo de 45 dólares en Super Ahorro"));
    const span = listSpans(h.deps.ops, s.sessionId).find((x) => x.name === "bank.node.router")!;
    expect(span.attributes["bank.router.label"]).toBe("dispute_charge");
    expect(typeof span.attributes["bank.router.confidence"]).toBe("number");
    // Brief said "keyword"; the keyword router's actual name (server/router/keyword.ts) is "keyword-v1" — corrected
    // to match existing server behavior rather than weakened (see task-1-report.md).
    expect(span.attributes["bank.router.name"]).toBe("keyword-v1");
  });
});
