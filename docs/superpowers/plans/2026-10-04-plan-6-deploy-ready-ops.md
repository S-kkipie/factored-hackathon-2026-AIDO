# Plan 6 — Deploy-Ready Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the system ready to deploy on Google Cloud Run with one command, without deploying it now; the user deploys later from another environment. Three pieces:
- spans exported to Langfuse over OTLP/HTTP;
- Google Model Armor as an inspect-only prompt-injection signal;
- a container image and a parameterized deploy script.

Every external integration is off unless configured, and all of them are tested with fakes.

**Architecture:**
- **Spans:** `Tracer` keeps writing every span to `ops.sqlite`. It now also forwards each span to an optional sink. `server/otel.ts` implements that sink: it batches spans and POSTs OTLP/HTTP JSON to Langfuse with Basic auth. Export failures are swallowed, so tracing never breaks a turn.
- **Model Armor:** `server/gates/model-armor.ts` calls `sanitizeUserPrompt` on the regional endpoint. On Cloud Run it gets a bearer token from the metadata server. It has a short timeout and adds its verdict to the existing heuristic injection signal. Spec 4.5: it never blocks on its own; a match raises session risk exactly like the heuristic does. Every call is audited and traced.
- **Container:** a multi-stage `Dockerfile`. The build stage runs `bun install` and `vite build`. The runtime stage holds the server, `ml/models`, `web/dist` and the private `data/serving.sqlite`; operational state lives on `/tmp`.
- **Deploy script:** `deploy/deploy.ts` prints or runs the `gcloud` commands: Artifact Registry, `run deploy` with `--max-instances=1`, and secrets from Secret Manager. `docs/deploy.md` is the runbook.

**Tech Stack:** Bun 1.3, TypeScript, Elysia, Docker (`oven/bun:1.3`), gcloud CLI, Langfuse OTLP endpoint `/api/public/otel/v1/traces` (HTTP/JSON, header `x-langfuse-ingestion-version: 4`), Model Armor REST `v1`.

**Spec:** `docs/superpowers/specs/2026-10-02-banking-cs-system-design.md` (sections 4.5 and 8)

## Global Constraints

- **Nothing in this plan calls GCP, Langfuse or Gemini for real.** Tests use injected `fetch` fakes. The Docker check runs the container locally with `GEMINI_API_KEY` empty.
- **Integrations are opt-in through env:**
  - Langfuse needs `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL` (default `https://cloud.langfuse.com`).
  - Model Armor needs `MODEL_ARMOR_PROJECT`, `MODEL_ARMOR_LOCATION` and `MODEL_ARMOR_TEMPLATE`.
  - If any of them is missing, that integration is off and the server behaves exactly as today.
- **No content leaves the system in spans.** OTLP attributes are the existing span attributes: ids, counts, rule ids, decisions, model and token usage. The session id appears only as the existing hashed `gen_ai.conversation.id`, which is also sent as `langfuse.session.id`. The user text sent to Model Armor is the PII-masked text from the input gate.
- **Model Armor is inspect-only.**
  - A `MATCH_FOUND` on `pi_and_jailbreak` with confidence `MEDIUM_AND_ABOVE`/`HIGH` (or `LOW_AND_ABOVE` when configured) counts as an injection signal: same effect as `injectionSignal`, which is the risk increment plus `IN_INJECTION`.
  - Errors, timeouts and skips count as "no signal" and are audited as `model_armor_error`.
  - The timeout defaults to 1500 ms.
- **Deployed spend cap: USD 3** (user decision, 2026-10-04). The deploy script sets `LLM_TOTAL_CAP_USD=3`. The ledger lives on the instance's `/tmp`; the runbook says the cap applies per instance lifetime.
- **Never commit secrets.** The deploy script reads secret *names*, never values. `data/serving.sqlite` goes into the image (a private registry), never into git.
- **Cloud Run runs a single instance** (`--max-instances=1`): sessions, locks and the breaker are in-process (spec 8).

## File Structure

| File | Responsibility |
|---|---|
| `server/otel.ts` | `createOtlpExporter`: span batching, OTLP/HTTP JSON payload, Basic auth, flush and shutdown |
| `server/trace.ts` (modify) | optional `SpanSink`; `Tracer` forwards recorded spans |
| `server/gates/model-armor.ts` | `createModelArmor`: token provider, `sanitizeUserPrompt` call, verdict mapping |
| `server/graph/turn.ts` (modify) | `TurnDeps.sink?` and `TurnDeps.armor?`; the injection signal combines heuristic and Model Armor |
| `server/config.ts`, `server/main.ts` (modify) | env for Langfuse and Model Armor; wiring; flush on SIGTERM |
| `Dockerfile`, `.dockerignore` | build and runtime image |
| `deploy/deploy.ts` | `bun run deploy -- --project … --region … [--execute]` |
| `docs/deploy.md` | runbook: one-time setup (APIs, Artifact Registry, Secret Manager, Model Armor template, Langfuse keys), deploy, verify, roll back |
| `README.md` (modify) | Deploy section, Operations notes |
| `tests/server/otel.test.ts`, `tests/server/model-armor.test.ts`, `tests/deploy/deploy.test.ts` | tests |

---

### Task 1: Langfuse OTLP exporter

**Files:**
- Create: `server/otel.ts`
- Modify: `server/trace.ts`, `server/graph/turn.ts` (`TurnDeps.sink?`, passed to `new Tracer`), `server/config.ts`, `server/main.ts`
- Test: `tests/server/otel.test.ts`

**Interfaces:**
- Produces:
  - in `server/trace.ts`: `export interface SpanSink { push(span: SpanRecord): void }`; `new Tracer(ops, sessionId, traceId?, sink?)`, where `record` calls `sink?.push(record)` after the insert;
  - `createOtlpExporter(o: { baseUrl: string; publicKey: string; secretKey: string; fetch?: typeof fetch; maxBatch?: number; flushMs?: number; serviceName?: string; environment?: string }): SpanSink & { flush(): Promise<void>; shutdown(): Promise<void> }`;
  - `toOtlpJson(spans: SpanRecord[], service: string, environment: string): unknown` (exported for tests);
  - `ServerConfig.langfuse: { baseUrl: string; publicKey: string; secretKey: string } | null`;
  - `TurnDeps.sink?: SpanSink`.

- [ ] **Step 1: Write the failing test**

`tests/server/otel.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createOtlpExporter, toOtlpJson } from "../../server/otel";
import { Tracer, type SpanRecord } from "../../server/trace";
import { makeOps } from "./fixtures";

const span = (p: Partial<SpanRecord> = {}): SpanRecord => ({
  span_id: "aaaaaaaaaaaaaaaa",
  trace_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  session_id: "raw-session-id",
  parent_id: null,
  name: "bank.node.router",
  started_at: "2026-10-04T10:00:00.000Z",
  duration_ms: 12.5,
  attributes: { "gen_ai.conversation.id": "c0ffee", "bank.rule_ids": ["POL_READ"], "bank.router.confidence": 0.97, "bank.gate.decision": "allow", "x.flag": true },
  ...p,
});

describe("toOtlpJson", () => {
  test("maps spans to OTLP/JSON with nanosecond times, typed attributes and the hashed session id only", () => {
    const body = toOtlpJson([span()], "aido", "demo") as {
      resourceSpans: { resource: { attributes: { key: string; value: Record<string, unknown> }[] }; scopeSpans: { spans: Record<string, unknown>[] }[] }[];
    };
    const rs = body.resourceSpans[0]!;
    expect(rs.resource.attributes).toContainEqual({ key: "service.name", value: { stringValue: "aido" } });
    const s = rs.scopeSpans[0]!.spans[0]! as { traceId: string; spanId: string; name: string; startTimeUnixNano: string; endTimeUnixNano: string; attributes: { key: string; value: Record<string, unknown> }[] };
    expect(s.traceId).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(s.spanId).toBe("aaaaaaaaaaaaaaaa");
    expect(s.startTimeUnixNano).toBe("1791108000000000000");
    expect(s.endTimeUnixNano).toBe("1791108000012500000");
    expect(s.attributes).toContainEqual({ key: "bank.rule_ids", value: { arrayValue: { values: [{ stringValue: "POL_READ" }] } } });
    expect(s.attributes).toContainEqual({ key: "bank.router.confidence", value: { doubleValue: 0.97 } });
    expect(s.attributes).toContainEqual({ key: "x.flag", value: { boolValue: true } });
    expect(s.attributes).toContainEqual({ key: "langfuse.session.id", value: { stringValue: "c0ffee" } });
    expect(JSON.stringify(body)).not.toContain("raw-session-id");
  });
});

describe("createOtlpExporter", () => {
  test("batches, posts to the Langfuse OTLP endpoint with Basic auth, and never throws", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let fail = false;
    const exporter = createOtlpExporter({
      baseUrl: "https://cloud.langfuse.com",
      publicKey: "pk-lf-1",
      secretKey: "sk-lf-2",
      maxBatch: 2,
      flushMs: 60_000,
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        if (fail) throw new Error("network down");
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    exporter.push(span({ span_id: "1111111111111111" }));
    expect(calls.length).toBe(0);
    exporter.push(span({ span_id: "2222222222222222" }));
    await exporter.flush();
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://cloud.langfuse.com/api/public/otel/v1/traces");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from("pk-lf-1:sk-lf-2").toString("base64")}`);
    expect(headers["x-langfuse-ingestion-version"]).toBe("4");
    expect(headers["content-type"]).toBe("application/json");
    fail = true;
    exporter.push(span());
    await exporter.shutdown();
    expect(calls.length).toBe(2);
  });

  test("the Tracer forwards each recorded span to its sink", () => {
    const pushed: SpanRecord[] = [];
    const tracer = new Tracer(makeOps(), "s1", undefined, { push: (s) => pushed.push(s) });
    tracer.record("bank.node.greet", { "bank.node": "greet" }, new Date("2026-10-04T10:00:00Z"), 3);
    expect(pushed.length).toBe(1);
    expect(pushed[0]!.name).toBe("bank.node.greet");
    expect(pushed[0]!.attributes["gen_ai.conversation.id"]).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/server/otel.test.ts`
Expected: FAIL with `Cannot find module '../../server/otel'`.

- [ ] **Step 3: Implement**

In `server/trace.ts`:
- Add `export interface SpanSink { push(span: SpanRecord): void }`.
- Change the constructor to `constructor(private readonly ops: Database, readonly sessionId: string, traceId?: string, private readonly sink?: SpanSink)`.
- In `record`, build the full `SpanRecord` object, with `attributes` including `gen_ai.conversation.id`.
- Insert it as today, then call `this.sink?.push(rec)`.

`server/otel.ts`:

```ts
import type { AttrValue, SpanRecord, SpanSink } from "./trace";

type OtlpValue = { stringValue: string } | { doubleValue: number } | { intValue: string } | { boolValue: boolean } | { arrayValue: { values: OtlpValue[] } };

function value(v: AttrValue): OtlpValue | null {
  if (v === null) return null;
  if (Array.isArray(v)) return { arrayValue: { values: v.map((x) => ({ stringValue: String(x) })) } };
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: v };
}

const nanos = (ms: number): string => (BigInt(Math.round(ms * 1000)) * 1000n).toString();

/** OTLP/HTTP JSON for a batch of persisted spans. The raw session id is never sent; only the hashed conversation id. */
export function toOtlpJson(spans: SpanRecord[], service: string, environment: string): unknown {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: service } },
            { key: "deployment.environment", value: { stringValue: environment } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "aido", version: "1" },
            spans: spans.map((s) => {
              const start = Date.parse(s.started_at);
              const attrs = { ...s.attributes, "langfuse.session.id": s.attributes["gen_ai.conversation.id"] ?? null, "langfuse.environment": environment };
              return {
                traceId: s.trace_id,
                spanId: s.span_id,
                ...(s.parent_id ? { parentSpanId: s.parent_id } : {}),
                name: s.name,
                kind: 1,
                startTimeUnixNano: nanos(start),
                endTimeUnixNano: nanos(start + s.duration_ms),
                attributes: Object.entries(attrs).flatMap(([key, v]) => {
                  const val = value(v as AttrValue);
                  return val ? [{ key, value: val }] : [];
                }),
                status: { code: s.attributes["error.type"] ? 2 : 1 },
              };
            }),
          },
        ],
      },
    ],
  };
}

/**
 * Span sink that ships spans to Langfuse's OTLP endpoint (spec 8). Spans are batched (size or interval) and posted
 * as OTLP/HTTP JSON. Export is best effort: a failed post is dropped and never reaches the turn.
 */
export function createOtlpExporter(o: {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  fetch?: typeof fetch;
  maxBatch?: number;
  flushMs?: number;
  serviceName?: string;
  environment?: string;
}): SpanSink & { flush(): Promise<void>; shutdown(): Promise<void> } {
  const doFetch = o.fetch ?? fetch;
  const url = `${o.baseUrl.replace(/\/$/, "")}/api/public/otel/v1/traces`;
  const auth = `Basic ${Buffer.from(`${o.publicKey}:${o.secretKey}`).toString("base64")}`;
  const maxBatch = o.maxBatch ?? 50;
  let queue: SpanRecord[] = [];
  let inflight: Promise<void> = Promise.resolve();

  const send = (batch: SpanRecord[]) =>
    doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth, "x-langfuse-ingestion-version": "4" },
      body: JSON.stringify(toOtlpJson(batch, o.serviceName ?? "aido", o.environment ?? "demo")),
      signal: AbortSignal.timeout(5000),
    }).then(
      () => undefined,
      () => undefined,
    );

  const flush = async () => {
    if (queue.length === 0) return inflight;
    const batch = queue;
    queue = [];
    inflight = inflight.then(() => send(batch));
    return inflight;
  };

  const timer = setInterval(() => void flush(), o.flushMs ?? 5000);
  (timer as { unref?: () => void }).unref?.();

  return {
    push(span) {
      queue.push(span);
      if (queue.length >= maxBatch) void flush();
    },
    flush,
    async shutdown() {
      clearInterval(timer);
      await flush();
    },
  };
}
```

`server/config.ts`: add `langfuse: { baseUrl: string; publicKey: string; secretKey: string } | null` to `ServerConfig`. In `loadServerConfig`, set it to `env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY ? { baseUrl: env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com", publicKey: env.LANGFUSE_PUBLIC_KEY, secretKey: env.LANGFUSE_SECRET_KEY } : null`.

`server/graph/turn.ts`: add `/** Optional span exporter (Langfuse OTLP); spans are always persisted to ops.sqlite. */ sink?: SpanSink;` to `TurnDeps`. In `graphFor`, construct the tracer with `new Tracer(deps.ops, session.sessionId, undefined, deps.sink)`.

`server/main.ts`:
- In `createServer`, build `const sink = cfg.langfuse ? createOtlpExporter({ ...cfg.langfuse, environment: env.DEPLOY_ENV ?? "local" }) : undefined;`.
- Pass `sink` into `createApp({... , sink })` and return it.
- In the `import.meta.main` block, register `process.on("SIGTERM", () => void sink?.shutdown().finally(() => process.exit(0)))`.
- Add `· traces → Langfuse` to the startup line when the sink is set.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/server/otel.test.ts && bun test && bun run typecheck`
Expected: PASS. The expected `startTimeUnixNano` equals `Date.parse("2026-10-04T10:00:00.000Z")` × 1e6. Verify it with `bun -e 'console.log(Date.parse("2026-10-04T10:00:00.000Z"))'`, and if the brief's literal is off, fix the literal to the computed value.

- [ ] **Step 5: Commit**

```bash
git add server/otel.ts server/trace.ts server/graph/turn.ts server/config.ts server/main.ts tests/server/otel.test.ts
git commit -m "feat(ops): optional Langfuse OTLP/HTTP span export (hashed session id only, best effort)"
```

---

### Task 2: Model Armor as an inspect-only injection signal

**Files:**
- Create: `server/gates/model-armor.ts`
- Modify: `server/graph/turn.ts`, `server/config.ts`, `server/main.ts`, `server/rules.ts` (none needed if `IN_INJECTION` is reused; do not add ids)
- Test: `tests/server/model-armor.test.ts`

**Interfaces:**
- Produces:
  - `interface PromptInspector { inspect(text: string): Promise<{ flagged: boolean; detail: string }> }`;
  - `createModelArmor(o: { project: string; location: string; template: string; fetch?: typeof fetch; token?: () => Promise<string>; timeoutMs?: number; minConfidence?: "LOW_AND_ABOVE" | "MEDIUM_AND_ABOVE" | "HIGH" }): PromptInspector`;
  - `metadataToken(fetchImpl?: typeof fetch): Promise<string>` (Cloud Run metadata server);
  - `ServerConfig.modelArmor: { project: string; location: string; template: string } | null`;
  - `TurnDeps.armor?: PromptInspector`.
- Behavior in `runTurnLocked`:
  - The injection signal becomes `injectionSignal(gate.text) || (await armorSignal(deps, sid, gate.text, tracer-free audit))`.
  - `armorSignal` calls `deps.armor.inspect` only when the armor is configured.
  - It records an audit event: `model_armor` with `{ flagged }`, or `model_armor_error` with `{}` on error or timeout.
  - It never throws. Errors count as `false`.

- [ ] **Step 1: Write the failing test**

`tests/server/model-armor.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/server/model-armor.test.ts`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement**

`server/gates/model-armor.ts`:

```ts
export interface PromptInspector {
  inspect(text: string): Promise<{ flagged: boolean; detail: string }>;
}

const RANK: Record<string, number> = { LOW: 1, MEDIUM: 2, HIGH: 3 };
const THRESHOLD = { LOW_AND_ABOVE: 1, MEDIUM_AND_ABOVE: 2, HIGH: 3 } as const;

/** Access token from the Cloud Run / GCE metadata server (the service account the service runs as). */
export async function metadataToken(fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
    headers: { "metadata-flavor": "Google" },
    signal: AbortSignal.timeout(1000),
  });
  if (!res.ok) throw new Error(`metadata token: ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/**
 * Google Model Armor, inspect-only (spec 4.5): the prompt-injection/jailbreak filter result becomes one more signal
 * next to the heuristic one. It never blocks; callers treat any error as "no signal".
 */
export function createModelArmor(o: {
  project: string;
  location: string;
  template: string;
  fetch?: typeof fetch;
  token?: () => Promise<string>;
  timeoutMs?: number;
  minConfidence?: keyof typeof THRESHOLD;
}): PromptInspector {
  const doFetch = o.fetch ?? fetch;
  const token = o.token ?? (() => metadataToken(doFetch));
  const url = `https://modelarmor.${o.location}.rep.googleapis.com/v1/projects/${o.project}/locations/${o.location}/templates/${o.template}:sanitizeUserPrompt`;
  const min = THRESHOLD[o.minConfidence ?? "MEDIUM_AND_ABOVE"];
  return {
    async inspect(text) {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${await token()}` },
        body: JSON.stringify({ userPromptData: { text } }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 1500),
      });
      if (!res.ok) throw new Error(`model armor: ${res.status}`);
      const body = (await res.json()) as {
        sanitizationResult?: { filterResults?: { pi_and_jailbreak?: { piAndJailbreakFilterResult?: { matchState?: string; confidenceLevel?: string } } } };
      };
      const pi = body.sanitizationResult?.filterResults?.pi_and_jailbreak?.piAndJailbreakFilterResult;
      const flagged = pi?.matchState === "MATCH_FOUND" && (RANK[pi.confidenceLevel ?? ""] ?? 0) >= min;
      return { flagged, detail: `pi_and_jailbreak ${pi?.matchState ?? "n/a"} ${pi?.confidenceLevel ?? ""}`.trim() };
    },
  };
}
```

`server/graph/turn.ts`:
- Add `/** Optional Model Armor inspector (inspect-only signal, spec 4.5). */ armor?: PromptInspector;` to `TurnDeps`.
- Add a helper:

```ts
async function armorSignal(deps: TurnDeps, sessionId: string, text: string): Promise<boolean> {
  if (!deps.armor) return false;
  try {
    const r = await deps.armor.inspect(text);
    appendAudit(deps.ops, { sessionId, kind: "model_armor", payload: { flagged: r.flagged } });
    return r.flagged;
  } catch {
    appendAudit(deps.ops, { sessionId, kind: "model_armor_error", payload: {} });
    return false;
  }
}
```

- In `runTurnLocked`, replace `freshTurn(gate.text, lang, injectionSignal(gate.text))` with `freshTurn(gate.text, lang, injectionSignal(gate.text) || (await armorSignal(deps, sid, gate.text)))`.

`server/config.ts`: add `modelArmor: { project: string; location: string; template: string } | null`, set from `MODEL_ARMOR_PROJECT`, `MODEL_ARMOR_LOCATION` and `MODEL_ARMOR_TEMPLATE` (all three required, otherwise `null`).

`server/main.ts`: add `armor: cfg.modelArmor ? createModelArmor(cfg.modelArmor) : undefined` to the `createApp` deps, and `· Model Armor` to the startup line when configured.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/server/model-armor.test.ts && bun test && bun run typecheck`
Expected: PASS. Check how `routerNode` turns `s.injection` into `IN_INJECTION` and the risk increment. The test's assertions follow that existing path. If a greeting route bypasses `routerNode`'s injection handling, use a non-greeting message such as "¿Cuál es mi saldo?" in the turn test, and say so in the report.

- [ ] **Step 5: Commit**

```bash
git add server/gates/model-armor.ts server/graph/turn.ts server/config.ts server/main.ts tests/server/model-armor.test.ts
git commit -m "feat(gates): optional Google Model Armor prompt-injection signal (inspect-only, audited, never blocks)"
```

---

### Task 3: Container image

**Files:**
- Create: `Dockerfile`, `.dockerignore`
- Modify: `package.json` (script `docker:build`), `server/config.ts` (no change expected; confirm `PORT` and the `*_PATH` env vars suffice)

**Interfaces:**
- Produces an image that:
  - listens on `$PORT` (default 8080) and serves `web/dist` together with the API;
  - reads serving data from `/app/data/serving.sqlite`;
  - writes ops state and the spend ledger to `/tmp`;
  - runs as a non-root user.

- [ ] **Step 1: Write the Dockerfile**

`Dockerfile`:

```dockerfile
# Build: install all deps, build the web app.
FROM oven/bun:1.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build:web

# Runtime: production deps only, server code, models, built web app and the private serving snapshot.
FROM oven/bun:1.3-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    WEB_DIR=/app/web/dist \
    SERVING_PATH=/app/data/serving.sqlite \
    OPS_PATH=/tmp/ops.sqlite \
    SPEND_LEDGER_PATH=/tmp/spend-ledger.sqlite
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/server ./server
COPY --from=build /app/pipeline/config.ts ./pipeline/config.ts
COPY --from=build /app/ml/models ./ml/models
COPY --from=build /app/web/dist ./web/dist
COPY data/serving.sqlite ./data/serving.sqlite
USER bun
EXPOSE 8080
CMD ["bun", "server/main.ts"]
```

`.dockerignore`:

```
node_modules
.git
.worktrees
.superpowers
.playwright-mcp
.env
data/*
!data/serving.sqlite
docs
reports
experiments
redteam/output
redteam/redteam.yaml
web/dist
```

`package.json` script: `"docker:build": "docker build -t aido:local ."`.

Check the server's import graph before relying on `COPY ... ./pipeline/config.ts` alone: run `grep -rn "from \"../pipeline\|from \"../../pipeline" server`. If the server imports more than `pipeline/config.ts`, copy those files too, and check that `pipeline/config.ts` itself imports nothing else.

- [ ] **Step 2: Build and run locally (no paid calls)**

```bash
bun run docker:build
docker run --rm -d --name aido-check -p 18080:8080 -e JWT_SECRET=$(openssl rand -hex 32) -e GEMINI_API_KEY= aido:local
sleep 3
curl -s localhost:18080/api/health
curl -s -o /dev/null -w "%{http_code}\n" localhost:18080/login
docker logs aido-check | head -5
docker stop aido-check
```

Expected:
- `{"ok":true}` from the health check;
- `200` for `/login`;
- a startup line that says the model is "none" and the router is "keyword" (no key).

If the build fails on a missing file, fix the COPY list. Record the image size.

- [ ] **Step 3: Commit**

```bash
git add Dockerfile .dockerignore package.json
git commit -m "build: multi-stage Cloud Run image (web build, prod deps, private serving snapshot, non-root)"
```

---

### Task 4: Deploy script and runbook

**Files:**
- Create: `deploy/deploy.ts`, `docs/deploy.md`
- Modify: `package.json` (script `deploy`), `README.md`, `tsconfig.json` (include `deploy`), `.gitignore` (`!docs/deploy.md` if `docs/*` is ignored)
- Test: `tests/deploy/deploy.test.ts`

**Interfaces:**
- Produces:
  - `deployCommands(o: { project: string; region: string; service: string; repo: string; tag: string; langfuse: boolean; modelArmor: { location: string; template: string } | null; capUsd: number }): string[][]`, a list of argv arrays;
  - CLI `bun run deploy -- --project P --region R [--service aido] [--repo aido] [--tag <git sha>] [--langfuse] [--model-armor-template T --model-armor-location L] [--execute]`. Without `--execute` it prints the commands. With it, it runs them in order and stops on the first failure.

- [ ] **Step 1: Write the failing test**

`tests/deploy/deploy.test.ts`:

```ts
import { expect, test } from "bun:test";
import { deployCommands } from "../../deploy/deploy";

test("deploy commands: build and push to Artifact Registry, then a single-instance Cloud Run deploy with secrets", () => {
  const cmds = deployCommands({ project: "p1", region: "us-central1", service: "aido", repo: "aido", tag: "abc123", langfuse: true, modelArmor: { location: "us-central1", template: "aido-pi" }, capUsd: 3 });
  const image = "us-central1-docker.pkg.dev/p1/aido/aido:abc123";
  expect(cmds[0]).toEqual(["docker", "build", "-t", image, "."]);
  expect(cmds[1]).toEqual(["docker", "push", image]);
  const run = cmds[2]!;
  expect(run.slice(0, 4)).toEqual(["gcloud", "run", "deploy", "aido"]);
  const flag = (name: string) => run[run.indexOf(name) + 1];
  expect(flag("--image")).toBe(image);
  expect(flag("--project")).toBe("p1");
  expect(flag("--region")).toBe("us-central1");
  expect(flag("--max-instances")).toBe("1");
  expect(run).toContain("--allow-unauthenticated");
  expect(flag("--set-secrets")).toBe("GEMINI_API_KEY=aido-gemini-api-key:latest,JWT_SECRET=aido-jwt-secret:latest,DEMO_PIN=aido-demo-pin:latest,AGENT_PIN=aido-agent-pin:latest,LANGFUSE_PUBLIC_KEY=aido-langfuse-public-key:latest,LANGFUSE_SECRET_KEY=aido-langfuse-secret-key:latest");
  const envs = flag("--set-env-vars")!;
  expect(envs).toContain("LLM_TOTAL_CAP_USD=3");
  expect(envs).toContain("MODEL_ARMOR_PROJECT=p1");
  expect(envs).toContain("MODEL_ARMOR_LOCATION=us-central1");
  expect(envs).toContain("MODEL_ARMOR_TEMPLATE=aido-pi");
  expect(envs).toContain("DEPLOY_ENV=cloud-run");
  expect(JSON.stringify(cmds)).not.toMatch(/sk-lf-|AIza/);
});

test("integrations are omitted when not requested", () => {
  const run = deployCommands({ project: "p1", region: "r", service: "aido", repo: "aido", tag: "t", langfuse: false, modelArmor: null, capUsd: 3 })[2]!;
  expect(run[run.indexOf("--set-secrets") + 1]).not.toContain("LANGFUSE");
  expect(run[run.indexOf("--set-env-vars") + 1]).not.toContain("MODEL_ARMOR");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/deploy/deploy.test.ts`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement**

`deploy/deploy.ts`:

```ts
import { parseArgs } from "node:util";

export interface DeployOptions {
  project: string;
  region: string;
  service: string;
  repo: string;
  tag: string;
  langfuse: boolean;
  modelArmor: { location: string; template: string } | null;
  capUsd: number;
}

/** Secret Manager names → env vars. Values live only in Secret Manager; this script never reads them. */
const SECRETS: [env: string, secret: string][] = [
  ["GEMINI_API_KEY", "aido-gemini-api-key"],
  ["JWT_SECRET", "aido-jwt-secret"],
  ["DEMO_PIN", "aido-demo-pin"],
  ["AGENT_PIN", "aido-agent-pin"],
];
const LANGFUSE_SECRETS: [string, string][] = [
  ["LANGFUSE_PUBLIC_KEY", "aido-langfuse-public-key"],
  ["LANGFUSE_SECRET_KEY", "aido-langfuse-secret-key"],
];

/** The deploy as argv arrays (spec 8: single container on Cloud Run, max-instances=1, secrets from Secret Manager). */
export function deployCommands(o: DeployOptions): string[][] {
  const image = `${o.region}-docker.pkg.dev/${o.project}/${o.repo}/${o.service}:${o.tag}`;
  const secrets = [...SECRETS, ...(o.langfuse ? LANGFUSE_SECRETS : [])].map(([env, name]) => `${env}=${name}:latest`).join(",");
  const envs = [
    `LLM_TOTAL_CAP_USD=${o.capUsd}`,
    "DEPLOY_ENV=cloud-run",
    ...(o.modelArmor ? [`MODEL_ARMOR_PROJECT=${o.project}`, `MODEL_ARMOR_LOCATION=${o.modelArmor.location}`, `MODEL_ARMOR_TEMPLATE=${o.modelArmor.template}`] : []),
  ].join(",");
  return [
    ["docker", "build", "-t", image, "."],
    ["docker", "push", image],
    [
      "gcloud", "run", "deploy", o.service,
      "--image", image,
      "--project", o.project,
      "--region", o.region,
      "--platform", "managed",
      "--allow-unauthenticated",
      "--max-instances", "1",
      "--min-instances", "0",
      "--memory", "1Gi",
      "--cpu", "1",
      "--timeout", "300",
      "--set-secrets", secrets,
      "--set-env-vars", envs,
    ],
  ];
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      project: { type: "string" },
      region: { type: "string", default: "us-central1" },
      service: { type: "string", default: "aido" },
      repo: { type: "string", default: "aido" },
      tag: { type: "string" },
      langfuse: { type: "boolean", default: false },
      "model-armor-template": { type: "string" },
      "model-armor-location": { type: "string" },
      "cap-usd": { type: "string", default: "3" },
      execute: { type: "boolean", default: false },
    },
  });
  if (!values.project) throw new Error("--project is required");
  const tag = values.tag ?? Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]).stdout.toString().trim();
  const cmds = deployCommands({
    project: values.project,
    region: values.region!,
    service: values.service!,
    repo: values.repo!,
    tag,
    langfuse: values.langfuse!,
    modelArmor: values["model-armor-template"] ? { template: values["model-armor-template"], location: values["model-armor-location"] ?? values.region! } : null,
    capUsd: Number(values["cap-usd"]),
  });
  for (const cmd of cmds) {
    console.log(`$ ${cmd.map((a) => (/[\s,=]/.test(a) ? `'${a}'` : a)).join(" ")}`);
    if (values.execute) {
      const r = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
      if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
    }
  }
  if (!values.execute) console.log("\n(dry run: add --execute to run these commands; see docs/deploy.md for one-time setup)");
}
```

`package.json`: `"deploy": "bun deploy/deploy.ts"`. `tsconfig.json`: add `"deploy"` to `include`. `.gitignore`: add `!docs/deploy.md` after `!docs/screenshots/`.

`docs/deploy.md`, the runbook. It must be complete commands, not prose only. Sections:
1. **Prerequisites:** gcloud, docker, a GCP project with billing, and `data/serving.sqlite` built locally (`bun run pipeline`).
2. **One-time setup.** Enable the APIs:
   ```bash
   gcloud services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com modelarmor.googleapis.com --project P
   ```
   Then:
   - `gcloud artifacts repositories create aido --repository-format=docker --location=R`
   - `gcloud auth configure-docker R-docker.pkg.dev`
   - For each secret in `SECRETS` (and the Langfuse ones): `printf %s "$VALUE" | gcloud secrets create NAME --data-file=- --project P`
   - Grant the Cloud Run runtime service account `roles/secretmanager.secretAccessor`. If Model Armor is used, also grant `roles/modelarmor.user`.
   - Model Armor template:
     ```bash
     gcloud model-armor templates create aido-pi --location R --pi-and-jailbreak-filter-settings-enforcement=enabled --pi-and-jailbreak-filter-settings-confidence-level=MEDIUM_AND_ABOVE --project P
     ```
     State that the exact flags must be checked against `gcloud model-armor templates create --help` at deploy time.
   - Langfuse: create a project at cloud.langfuse.com and copy its public and secret keys into the two secrets.
3. **Deploy:** `bun run deploy -- --project P --region R --langfuse --model-armor-template aido-pi`, which prints the commands. Then add `--execute`.
4. **Verify:**
   - `curl $URL/api/health`;
   - open `$URL/login`;
   - one chat turn;
   - traces visible in Langfuse;
   - the audit row `model_armor` in the trace.
5. **Operations notes:**
   - The ledger cap (USD 3) applies per instance lifetime, because `/tmp` is reset on restart.
   - `max-instances=1`: sessions, locks and the breaker are in-process.
   - Ops data is ephemeral. The production path is Cloud SQL; see "Known limitations".
   - Rotate the demo PINs for any shared deployment.
6. **Roll back:** `gcloud run services update-traffic aido --to-revisions PREV=100 --region R`.

README: add a "Deploy" section that links `docs/deploy.md` and gives the one dry-run command. Mark roadmap row 6 "deploy-ready (deploy pending: performed from the team's GCP environment)".

- [ ] **Step 4: Tests and typecheck**

Run: `bun test && bun run typecheck && bun run deploy -- --project demo-project --langfuse --model-armor-template aido-pi`
Expected: PASS. The dry run prints the three commands.

- [ ] **Step 5: Commit**

```bash
git add deploy/deploy.ts docs/deploy.md package.json tsconfig.json .gitignore README.md tests/deploy/deploy.test.ts
git commit -m "feat(deploy): parameterized Cloud Run deploy (dry run by default) and runbook"
```

---

### Task 5: Controller check and merge

- [ ] Run Task 3 Step 2 (container smoke) again on the final branch.
- [ ] Final whole-branch review. Merge to main and push (authorized by the user).
