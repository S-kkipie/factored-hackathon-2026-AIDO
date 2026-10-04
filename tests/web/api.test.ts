import { describe, expect, test } from "bun:test";
import { createApp } from "../../server/app";
import { ApiError, createApi } from "../../web/src/lib/api";
import { harness } from "../server/graph-harness";

async function inProcess() {
  const h = await harness();
  const app = createApp({ ...h.deps, auth: h.auth });
  const fetch = (path: string, init?: RequestInit) => app.handle(new Request(`http://localhost${path}`, init));
  return { h, fetch };
}

describe("typed API client", () => {
  test("sends JSON with the bearer token and parses JSON", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const api = createApi({
      token: () => "tok",
      fetch: async (url, init = {}) => {
        seen.push({ url, init });
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
      },
    });
    await api.reply("a/b", "hola");
    expect(seen[0]!.url).toBe("/api/agent/sessions/a%2Fb/reply");
    expect(seen[0]!.init.method).toBe("POST");
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ text: "hola" });
  });

  test("omits the authorization header without a token", async () => {
    let headers: Record<string, string> = {};
    const api = createApi({
      token: () => null,
      fetch: async (_url, init = {}) => {
        headers = init.headers as Record<string, string>;
        return new Response("[]");
      },
    });
    await api.demoUsers();
    expect(headers.authorization).toBeUndefined();
  });

  test("non-2xx responses throw ApiError with the rule id", async () => {
    const api = createApi({ token: () => null, fetch: async () => new Response(JSON.stringify({ ruleId: "IN_AUTH_001" }), { status: 401 }) });
    const err = await api.login("normal", "0000", "es").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect((err as ApiError).ruleId).toBe("IN_AUTH_001");
  });

  test("works end to end against the real app", async () => {
    const { fetch } = await inProcess();
    let token: string | null = null;
    const api = createApi({ token: () => token, fetch });
    expect((await api.demoUsers()).map((u) => u.persona)).toContain("normal");
    const s = await api.login("normal", "2468", "pt");
    token = s.token;
    expect(await api.session()).toMatchObject({ sessionId: s.sessionId, role: "customer", language: "pt", status: "active" });
    const denied = await api.queue().catch((e: unknown) => e);
    expect((denied as ApiError).status).toBe(403);
    expect(Array.isArray(await api.trace(s.sessionId))).toBe(true);
    await api.logout();
    expect(((await api.session().catch((e: unknown) => e)) as ApiError).status).toBe(401);
  });
});
