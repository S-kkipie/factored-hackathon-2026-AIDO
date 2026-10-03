import { describe, expect, test } from "bun:test";
import { AuthError, createAuth } from "../../server/auth";
import { openServing } from "../../server/db/serving";
import { FIXTURE, makeOps, makeServing } from "./fixtures";

const cfg = {
  jwtSecret: new TextEncoder().encode("s".repeat(32)),
  sessionTtlSeconds: 900,
  demoPin: "2468",
  agentPin: "1357",
};

function setup(start = Date.parse("2026-10-02T12:00:00Z")) {
  let nowMs = start;
  const ops = makeOps();
  const auth = createAuth(cfg, openServing(makeServing()), ops, () => nowMs);
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
    const { auth } = setup();
    const { token, session } = await auth.login("normal", "2468", "pt");
    expect(session.customerId).toEqual({ v: FIXTURE.normal, src: "jwt" });
    expect(session.language).toBe("pt");
    const verified = await auth.verify(token);
    expect(verified.sessionId).toBe(session.sessionId);
    expect(verified.customerId).toEqual({ v: FIXTURE.normal, src: "jwt" });
  });

  test("rejects wrong pin and unknown persona", async () => {
    const { auth } = setup();
    expect(await ruleOf(auth.login("normal", "0000", "es"))).toBe("IN_AUTH_001");
    expect(await ruleOf(auth.login("ghost", "2468", "es"))).toBe("IN_AUTH_001");
  });

  test("expired and tampered tokens are rejected", async () => {
    const { auth, advance } = setup();
    const { token } = await auth.login("normal", "2468", "es");
    expect(await ruleOf(auth.verify(`${token.slice(0, -2)}xx`))).toBe("IN_AUTH_002");
    advance(16 * 60 * 1000);
    expect(await ruleOf(auth.verify(token))).toBe("IN_SESSION_EXPIRED");
  });

  test("revoked sessions are rejected", async () => {
    const { auth, ops } = setup();
    const { token, session } = await auth.login("normal", "2468", "es");
    ops.query("update sessions set status = 'closed' where session_id = ?").run(session.sessionId);
    expect(await ruleOf(auth.verify(token))).toBe("IN_SESSION_REVOKED");
  });

  test("agent login has no customer", async () => {
    const { auth } = setup();
    expect(await ruleOf(auth.agentLogin("bad"))).toBe("IN_AUTH_001");
    const { token } = await auth.agentLogin("1357");
    const s = await auth.verify(token);
    expect(s.role).toBe("agent");
    expect(s.customerId).toBeNull();
  });
});
