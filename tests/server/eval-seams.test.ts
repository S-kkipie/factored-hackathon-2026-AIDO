import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../server/main";
import { FIXTURE, makeServing } from "./fixtures";
import { byPurpose, fakeLlm } from "./llm-fake";

function env() {
  const dir = mkdtempSync(join(tmpdir(), "aido-seams-"));
  return {
    JWT_SECRET: "eval-secret-eval-secret-eval-secret!!",
    SERVING_PATH: makeServing(),
    OPS_PATH: join(dir, "ops.sqlite"),
    SPEND_LEDGER_PATH: join(dir, "ledger.sqlite"),
    WEB_DIR: join(dir, "no-web"),
    ROUTER: "keyword",
  };
}

async function sse(res: Response) {
  return (await res.text())
    .split("\n\n")
    .filter((b) => b.startsWith("data: "))
    .map((b) => JSON.parse(b.slice(6)) as Record<string, unknown>);
}

describe("createServer overrides", () => {
  test("a wrapped serving db can expose any customer as a login persona; rejected drafts reach the debug hook", async () => {
    const rejected: { draft: string; ruleIds: string[] }[] = [];
    const { app } = createServer(env(), {
      llm: fakeLlm(byPurpose({}, "Su saldo es 999.99 USD.")),
      wrapServing: (s) => ({ ...s, demoUsers: () => [{ persona: "eval", customer_id: FIXTURE.normal }] }),
      onDraftRejected: (draft, ruleIds) => rejected.push({ draft, ruleIds }),
    });
    const login = await app.handle(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ persona: "eval", pin: "2468", language: "es" }),
      }),
    );
    expect(login.status).toBe(200);
    const { token, sessionId } = (await login.json()) as { token: string; sessionId: string };
    const events = await sse(
      await app.handle(
        new Request("http://localhost/api/agui/run", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ threadId: sessionId, runId: "r1", messages: [{ id: "m", role: "user", content: "¿Cuál es mi saldo?" }] }),
        }),
      ),
    );
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
    expect(rejected).toEqual([{ draft: "Su saldo es 999.99 USD.", ruleIds: ["RS_AMOUNT"] }]);
  });

  test("the auth clock override expires sessions on demand", async () => {
    let offset = 0;
    const { app } = createServer(env(), { llm: null, authNow: () => Date.now() + offset });
    const login = await app.handle(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ persona: "normal", pin: "2468", language: "es" }),
      }),
    );
    const { token } = (await login.json()) as { token: string };
    offset = 16 * 60_000;
    const res = await app.handle(new Request("http://localhost/api/session", { headers: { authorization: `Bearer ${token}` } }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ruleId: "IN_SESSION_EXPIRED" });
  });

  test("tool wrappers are applied to the turn's tools", async () => {
    let calls = 0;
    const { app } = createServer(env(), {
      llm: null,
      wrapTools: (t) => ({
        ...t,
        getAccounts: (c) => {
          calls++;
          return t.getAccounts(c);
        },
      }),
    });
    const { token, sessionId } = (await (
      await app.handle(
        new Request("http://localhost/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ persona: "normal", pin: "2468", language: "es" }),
        }),
      )
    ).json()) as { token: string; sessionId: string };
    await (
      await app.handle(
        new Request("http://localhost/api/agui/run", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ threadId: sessionId, runId: "r1", messages: [{ id: "m", role: "user", content: "¿Cuál es mi saldo?" }] }),
        }),
      )
    ).text();
    expect(calls).toBe(1);
  });
});
