import { describe, expect, test } from "bun:test";
import { SignJWT } from "jose";
import { AuthError, createAuth } from "../../server/auth";
import { openServing } from "../../server/db/serving";
import { FIXTURE, makeDb } from "./fixtures";

const cfg = {
  jwtSecret: new TextEncoder().encode("s".repeat(32)),
  sessionTtlSeconds: 900,
  demoPin: "2468",
  agentPin: "1357",
};

async function setup(start = Date.parse("2026-10-02T12:00:00Z")) {
  let nowMs = start;
  const ops = (await makeDb());
  const auth = createAuth(cfg, openServing(ops), ops, () => nowMs);
  return { auth, ops, advance: (ms: number) => (nowMs += ms) };
}

async function ruleOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "no error";
  } catch (e) {
    return e instanceof AuthError ? e.ruleId : String(e);
  }
}

describe("auth", () => {
  test("customer login yields a jwt-sourced customer id", async () => {
    const { auth } = await setup();
    const { token, session } = await auth.login("normal", "2468", "pt");
    expect(session.customerId).toEqual({ v: FIXTURE.normal, src: "jwt" });
    expect(session.language).toBe("pt");
    const verified = await auth.verify(token);
    expect(verified.sessionId).toBe(session.sessionId);
    expect(verified.customerId).toEqual({ v: FIXTURE.normal, src: "jwt" });
  });

  test("rejects wrong pin and unknown persona", async () => {
    const { auth } = await setup();
    expect(await ruleOf(auth.login("normal", "0000", "es"))).toBe("IN_AUTH_001");
    expect(await ruleOf(auth.login("ghost", "2468", "es"))).toBe("IN_AUTH_001");
  });

  test("expired and tampered tokens are rejected", async () => {
    const { auth, advance } = await setup();
    const { token } = await auth.login("normal", "2468", "es");
    expect(await ruleOf(auth.verify(`${token.slice(0, -2)}xx`))).toBe("IN_AUTH_002");
    advance(16 * 60 * 1000);
    expect(await ruleOf(auth.verify(token))).toBe("IN_SESSION_EXPIRED");
  });

  test("revoked sessions are rejected", async () => {
    const { auth, ops } = await setup();
    const { token, session } = await auth.login("normal", "2468", "es");
    (await ops.run("update ops.sessions set status = 'closed' where session_id = $1", [session.sessionId]));
    expect(await ruleOf(auth.verify(token))).toBe("IN_SESSION_REVOKED");
  });

  test("agent login has no customer", async () => {
    const { auth } = await setup();
    expect(await ruleOf(auth.agentLogin("bad"))).toBe("IN_AUTH_001");
    const { token } = await auth.agentLogin("1357");
    const s = await auth.verify(token);
    expect(s.role).toBe("agent");
    expect(s.customerId).toBeNull();
  });
});

describe("session lifecycle", () => {
  test("revoke and setStatus end a session", async () => {
    const { auth } = await setup();
    const a = await auth.login("normal", "2468", "es");
    (await auth.revoke(a.session.sessionId));
    expect(await ruleOf(auth.verify(a.token))).toBe("IN_SESSION_REVOKED");

    const b = await auth.login("normal", "2468", "es");
    (await auth.setStatus(b.session.sessionId, "handed_off"));
    expect(await ruleOf(auth.verify(b.token))).toBe("IN_SESSION_REVOKED");
    (await auth.setStatus(b.session.sessionId, "active"));
    expect((await auth.verify(b.token)).sessionId).toBe(b.session.sessionId);
    (await auth.setStatus(b.session.sessionId, "closed"));
    expect(await ruleOf(auth.verify(b.token))).toBe("IN_SESSION_REVOKED");
  });

  test("unknown sessions are rejected", async () => {
    const { auth } = await setup();
    await expect(auth.revoke("ghost")).rejects.toThrow("IN_AUTH_002");
    await expect(auth.setStatus("ghost", "closed")).rejects.toThrow("IN_AUTH_002");
  });

  test("invalid statuses are rejected", async () => {
    const { auth } = await setup();
    const { session } = await auth.login("normal", "2468", "es");
    await expect(auth.setStatus(session.sessionId, "revoked" as never)).rejects.toThrow("IN_AUTH_002");
  });

  test("a validly signed token without sid is IN_AUTH_002", async () => {
    const { auth } = await setup();
    const iat = Math.floor(Date.parse("2026-10-02T12:00:00Z") / 1000);
    const token = await new SignJWT({ role: "customer", lang: "es" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(FIXTURE.normal)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 900)
      .sign(cfg.jwtSecret);
    expect(await ruleOf(auth.verify(token))).toBe("IN_AUTH_002");
  });
});
