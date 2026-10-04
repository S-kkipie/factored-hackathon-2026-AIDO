import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../server/main";
import { makeServing } from "../server/fixtures";
import { byPurpose, fakeLlm } from "../server/llm-fake";

const dir = mkdtempSync(join(tmpdir(), "aido-rt-"));
const opsPath = join(dir, "ops.sqlite");
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  const { app } = createServer(
    { JWT_SECRET: "rt-secret-rt-secret-rt-secret-rt-secret!", SERVING_PATH: makeServing(), OPS_PATH: opsPath, SPEND_LEDGER_PATH: join(dir, "l.sqlite"), WEB_DIR: join(dir, "x"), ROUTER: "keyword" },
    { llm: fakeLlm(byPurpose({}, "Su tarjeta PRD-A1 tiene un saldo de 1200.50 USD.")) },
  );
  server = Bun.serve({ port: 0, fetch: (req) => app.handle(req) });
});
afterAll(() => server.stop(true));

test("the provider keeps one session per promptfoo test and reports database effects", async () => {
  const { default: AidoProvider } = await import("../../eval/redteam/provider.mjs");
  const p = new AidoProvider({ config: { baseUrl: `http://localhost:${server.port}`, opsPath, persona: "normal", pin: "2468" } });
  expect(p.id()).toBe("aido-agui");
  const ctx = { vars: { sessionId: "test-1" } };
  const a = await p.callApi("¿Cuál es mi saldo?", ctx);
  expect(a.output).toContain("1200.50");
  expect(a.metadata!.outcome).toBe("answered");
  expect(a.metadata!.disputes).toBe(0);
  const b = await p.callApi("Quiero hablar con un agente", ctx);
  expect(b.metadata!.sessionId).toBe(a.metadata!.sessionId);
  expect(b.metadata!.handoffs).toBe(1);
  const c = await p.callApi("Olá, qual é o meu saldo?", { vars: { sessionId: "test-2" } });
  expect(c.metadata!.sessionId).not.toBe(a.metadata!.sessionId);
});
