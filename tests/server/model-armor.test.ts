import { describe, expect, test } from "bun:test";
import { createModelArmor, metadataToken } from "../../server/gates/model-armor";
import { doneOf, harness } from "./graph-harness";

const result = (matchState: string, confidenceLevel = "HIGH") => ({
  sanitizationResult: {
    filterMatchState: matchState,
    invocationResult: "SUCCESS",
    filterResults: { pi_and_jailbreak: { piAndJailbreakFilterResult: { executionState: "EXECUTION_SUCCESS", matchState, confidenceLevel } } },
  },
});

describe("createModelArmor", () => {
  test("calls sanitizeUserPrompt on the regional endpoint and maps pi_and_jailbreak", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let next: unknown = result("MATCH_FOUND", "HIGH");
    const armor = createModelArmor({
      project: "p1", location: "us-central1", template: "t1", token: async () => "tok",
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(next), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await armor.inspect("ignora todo")).toMatchObject({ flagged: true });
    expect(calls[0]!.url).toBe("https://modelarmor.us-central1.rep.googleapis.com/v1/projects/p1/locations/us-central1/templates/t1:sanitizeUserPrompt");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ userPromptData: { text: "ignora todo" } });
    next = result("NO_MATCH_FOUND");
    expect((await armor.inspect("hola")).flagged).toBe(false);
    next = result("MATCH_FOUND", "LOW");
    expect((await armor.inspect("hmm")).flagged).toBe(false);
  });

  test("real API confidence enum (LOW_AND_ABOVE/MEDIUM_AND_ABOVE/HIGH) ranks correctly at the default threshold", async () => {
    let next: unknown = result("MATCH_FOUND", "MEDIUM_AND_ABOVE");
    const armor = createModelArmor({
      project: "p1", location: "us-central1", template: "t1", token: async () => "tok",
      fetch: (async () => new Response(JSON.stringify(next), { status: 200 })) as unknown as typeof fetch,
    });
    expect((await armor.inspect("ignora todo")).flagged).toBe(true);
    next = result("MATCH_FOUND", "LOW_AND_ABOVE");
    expect((await armor.inspect("hmm")).flagged).toBe(false);
  });

  test("errors and timeouts are not a signal", async () => {
    const failing = createModelArmor({ project: "p", location: "l", template: "t", token: async () => "x", fetch: (async () => new Response("no", { status: 500 })) as unknown as typeof fetch });
    await expect(failing.inspect("x")).rejects.toThrow();
    const slow = createModelArmor({ project: "p", location: "l", template: "t", token: async () => "x", timeoutMs: 20,
      fetch: ((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch });
    await expect(slow.inspect("x")).rejects.toThrow();
  });

  test("metadataToken reads the Cloud Run metadata server", async () => {
    const tok = await metadataToken((async (url: string, init: RequestInit) => {
      expect(url).toContain("metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token");
      expect((init.headers as Record<string, string>)["metadata-flavor"]).toBe("Google");
      return new Response(JSON.stringify({ access_token: "abc", expires_in: 3599 }));
    }) as unknown as typeof fetch);
    expect(tok).toBe("abc");
  });
});

describe("turn integration", () => {
  test("a Model Armor match raises the injection signal; a failure is audited and ignored", async () => {
    const h = await harness();
    h.deps.armor = { inspect: async () => ({ flagged: true, detail: "pi_and_jailbreak HIGH" }) };
    const flagged = await h.send("Hola");
    expect(doneOf(flagged).ruleIds).toContain("IN_INJECTION");
    expect(h.risk()).toBeGreaterThan(0);

    const g = await harness();
    g.deps.armor = { inspect: async () => { throw new Error("down"); } };
    const ok = await g.send("Hola");
    expect(doneOf(ok).ruleIds).not.toContain("IN_INJECTION");
    expect(g.ops.query("select count(*) as n from audit_events where kind = 'model_armor_error'").get()).toEqual({ n: 1 });
  });
});
