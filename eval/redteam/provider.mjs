const PT = /(?<!\p{L})(?:você|não|olá|obrigad[oa]|qual|meu|minha|cobrança|contestação|conta)(?!\p{L})|ção|ã|õ/iu;

/**
 * Opens `path` read-only and returns a handle with `prepare(sql).get(...params)` and `close()`.
 *
 * node:sqlite's `DatabaseSync` (Node >= 22.5) is what this module would use unconditionally, but this provider
 * is also imported directly by Bun in tests (tests/eval/redteam-provider.test.ts), and Bun 1.3.x has no
 * `node:sqlite` built-in (`No such built-in module: node:sqlite`, verified against bun 1.3.14). So the sqlite
 * backend is picked at call time: under Bun (`globalThis.Bun` defined) it lazily imports `bun:sqlite` and opens
 * with `{ readonly: true }`; otherwise (promptfoo running this under plain Node) it lazily imports
 * `node:sqlite` and opens with `{ readOnly: true }`. Both expose the same `prepare().get()`/`close()` shape used
 * below, so no other code needs to branch on the runtime.
 */
async function openReadonly(path) {
  if (globalThis.Bun) {
    const { Database } = await import("bun:sqlite");
    return new Database(path, { readonly: true });
  }
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(path, { readOnly: true });
}

/**
 * promptfoo target for suite D: drives the real server over HTTP + AG-UI. One server session per promptfoo test
 * (keyed by vars.sessionId, set per test in the config), so multi-turn strategies (crescendo, goat) are stateful.
 * Database effects (disputes, handoffs created in this session) come from ops.sqlite, read-only.
 */
export default class AidoProvider {
  constructor(options = {}) {
    this.config = options.config ?? {};
    this.baseUrl = this.config.baseUrl ?? "http://localhost:8080";
    this.sessions = new Map();
  }

  id() {
    return "aido-agui";
  }

  async session(key, prompt) {
    let s = this.sessions.get(key);
    if (s) return s;
    const language = PT.test(prompt) ? "pt" : "es";
    const res = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ persona: this.config.persona ?? "normal", pin: this.config.pin ?? process.env.DEMO_PIN ?? "2468", language }),
    });
    if (!res.ok) throw new Error(`login failed: ${res.status}`);
    s = await res.json();
    this.sessions.set(key, s);
    return s;
  }

  async effects(sessionId) {
    if (!this.config.opsPath) return { disputes: null, handoffs: null };
    const db = await openReadonly(this.config.opsPath);
    try {
      const n = (table) => db.prepare(`select count(*) as n from ${table} where session_id = ?`).get(sessionId).n;
      return { disputes: n("disputes"), handoffs: n("handoffs") };
    } finally {
      db.close();
    }
  }

  async callApi(prompt, context) {
    const key = String(context?.vars?.sessionId ?? crypto.randomUUID());
    try {
      const s = await this.session(key, String(prompt));
      const res = await fetch(`${this.baseUrl}/api/agui/run`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${s.token}`, accept: "text/event-stream" },
        body: JSON.stringify({ threadId: s.sessionId, runId: crypto.randomUUID(), messages: [{ id: crypto.randomUUID(), role: "user", content: String(prompt) }] }),
      });
      if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
        const body = await res.json().catch(() => ({}));
        return { output: `[request rejected: ${body.ruleId ?? res.status}]`, metadata: { sessionId: s.sessionId, outcome: "blocked", ruleIds: body.ruleId ? [body.ruleId] : [], ...(await this.effects(s.sessionId)) } };
      }
      const events = (await res.text()).split("\n\n").filter((b) => b.startsWith("data: ")).map((b) => JSON.parse(b.slice(6)));
      const delta = events.filter((e) => e.type === "STATE_DELTA").flatMap((e) => e.delta);
      const get = (p) => delta.find((op) => op.path === p)?.value;
      const finished = events.find((e) => e.type === "RUN_FINISHED")?.outcome;
      const interrupt = finished?.type === "interrupt" ? finished.interrupts?.[0] : null;
      const text = events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta).join("\n");
      return {
        output: interrupt ? `${interrupt.message}\n[confirmation required: a button press, not a chat message]` : text,
        metadata: { sessionId: s.sessionId, outcome: get("/outcome") ?? null, ruleIds: get("/ruleIds") ?? [], ...(await this.effects(s.sessionId)) },
      };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
}
