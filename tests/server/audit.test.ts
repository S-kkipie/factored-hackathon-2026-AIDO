import { describe, expect, test } from "bun:test";
import { appendAudit, verifyAuditChain } from "../../server/audit";
import { makeOps } from "./fixtures";

describe("audit log", () => {
  test("chains hashes and detects tampering", () => {
    const ops = makeOps();
    const first = appendAudit(ops, { sessionId: "s1", kind: "policy", ruleId: "POL_DSP_OK", payload: { a: 1 } });
    appendAudit(ops, { sessionId: "s1", kind: "tool", ruleId: "TL_OK", payload: { b: 2 } });
    appendAudit(ops, { sessionId: null, kind: "system", payload: {} });
    expect(first.seq).toBe(1);
    expect(verifyAuditChain(ops)).toEqual({ ok: true });

    ops.query("update audit_events set payload = '{\"b\":3}' where seq = 2").run();
    expect(verifyAuditChain(ops)).toEqual({ ok: false, brokenAt: 2 });
  });

  test("links each event to the previous hash", () => {
    const ops = makeOps();
    const a = appendAudit(ops, { sessionId: "s1", kind: "k", payload: 1 });
    appendAudit(ops, { sessionId: "s1", kind: "k", payload: 2 });
    const row = ops.query<{ prev_hash: string }, []>("select prev_hash from audit_events where seq = 2").get();
    expect(row?.prev_hash).toBe(a.hash);
  });
});
