import { describe, expect, test } from "bun:test";
import { createAuth } from "../../server/auth";
import { loadServerConfig } from "../../server/config";
import { openServing } from "../../server/db/serving";
import { POLICY } from "../../server/policy/config";
import { FIXTURE, makeOps, makeServing } from "./fixtures";

const AUTH_CFG = {
  jwtSecret: new TextEncoder().encode("test-secret-test-secret-test-secret!"),
  sessionTtlSeconds: 900,
  demoPin: "2468",
  agentPin: "1357",
};

describe("session status on verify", () => {
  test("handed_off sessions verify only where explicitly allowed; closed never", async () => {
    const auth = createAuth(AUTH_CFG, openServing(makeServing()), makeOps());
    const { token, session } = await auth.login("normal", "2468", "es");
    expect((await auth.verify(token)).status).toBe("active");
    auth.setStatus(session.sessionId, "handed_off");
    await expect(auth.verify(token)).rejects.toThrow("IN_SESSION_REVOKED");
    const s = await auth.verify(token, ["active", "handed_off"]);
    expect(s.status).toBe("handed_off");
    expect(s.customerId).toEqual({ v: FIXTURE.normal, src: "jwt" });
    auth.setStatus(session.sessionId, "closed");
    await expect(auth.verify(token, ["active", "handed_off"])).rejects.toThrow("IN_SESSION_REVOKED");
  });
});

describe("plan 2b configuration", () => {
  test("model settings come from the environment with a pinned default", () => {
    const base = { JWT_SECRET: "x".repeat(32) };
    const cfg = loadServerConfig(base);
    expect(cfg.geminiApiKey).toBeNull();
    expect(cfg.geminiModel).toBe("gemini-3.8-flash");
    expect(cfg.port).toBe(8080);
    expect(loadServerConfig({ ...base, GEMINI_API_KEY: "k", GEMINI_MODEL: "m" })).toMatchObject({ geminiApiKey: "k", geminiModel: "m" });
  });

  test("policy version is bumped for audited decisions and carries router/template settings", () => {
    expect(POLICY.version).toBe("2026-10-03.1");
    expect(POLICY.routerThreshold).toBe(0.6);
    expect(POLICY.disputeReviewDays).toBe(10);
  });

  test("MODEL_TIMEOUT_MS and PORT must be finite positive integers", () => {
    const base = { JWT_SECRET: "x".repeat(32) };
    expect(() => loadServerConfig({ ...base, MODEL_TIMEOUT_MS: "0" })).toThrow("MODEL_TIMEOUT_MS");
    expect(() => loadServerConfig({ ...base, MODEL_TIMEOUT_MS: "-5" })).toThrow("MODEL_TIMEOUT_MS");
    expect(() => loadServerConfig({ ...base, MODEL_TIMEOUT_MS: "1.5" })).toThrow("MODEL_TIMEOUT_MS");
    expect(() => loadServerConfig({ ...base, MODEL_TIMEOUT_MS: "nope" })).toThrow("MODEL_TIMEOUT_MS");
    expect(() => loadServerConfig({ ...base, PORT: "0" })).toThrow("PORT");
    expect(() => loadServerConfig({ ...base, PORT: "-1" })).toThrow("PORT");
    expect(loadServerConfig({ ...base, MODEL_TIMEOUT_MS: "5000", PORT: "3000" })).toMatchObject({
      modelTimeoutMs: 5000,
      port: 3000,
    });
  });
});
