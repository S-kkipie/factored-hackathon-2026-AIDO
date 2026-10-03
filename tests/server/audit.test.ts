import { describe, expect, test } from "bun:test";
import { appendAudit, verifyAuditChain } from "../../server/audit";
import { makeDb } from "./fixtures";

describe("audit log", () => {
  test("chains hashes and detects tampering", async () => {
    const ops = await makeDb();
    const first = await appendAudit(ops, { sessionId: "s1", kind: "policy", ruleId: "POL_DSP_OK", payload: { a: 1 } });
    await appendAudit(ops, { sessionId: "s1", kind: "tool", ruleId: "TL_OK", payload: { b: 2 } });
    await appendAudit(ops, { sessionId: null, kind: "system", payload: {} });
    expect(first.seq).toBe(1);
    expect(await verifyAuditChain(ops)).toEqual({ ok: true });

    await ops.run("update ops.audit_events set payload = '{\"b\":3}' where seq = 2");
    expect(await verifyAuditChain(ops)).toEqual({ ok: false, brokenAt: 2 });
  });

  test("links each event to the previous hash", async () => {
    const ops = await makeDb();
    const a = await appendAudit(ops, { sessionId: "s1", kind: "k", payload: 1 });
    await appendAudit(ops, { sessionId: "s1", kind: "k", payload: 2 });
    const row = await ops.one<{ prev_hash: string }>("select prev_hash from ops.audit_events where seq = 2");
    expect(row?.prev_hash).toBe(a.hash);
  });

  test("concurrent appends keep a single unbroken chain", async () => {
    const ops = await makeDb();
    await Promise.all(Array.from({ length: 20 }, (_, i) => appendAudit(ops, { sessionId: "s1", kind: "k", payload: i })));
    expect(await verifyAuditChain(ops)).toEqual({ ok: true });
    expect((await ops.one<{ n: number }>("select count(*)::int as n from ops.audit_events"))?.n).toBe(20);
  });
});
