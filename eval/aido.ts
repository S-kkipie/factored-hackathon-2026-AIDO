import type { SpendLedger } from "../server/llm/ledger";
import type { Llm } from "../server/llm/types";
import { createServer } from "../server/main";
import type { Scenario } from "./scenarios";
import type { ScenarioResult, TurnRecord } from "./types";
import { customerOf, effects, scenarioDb, withFailure } from "./world";

/** Rule ids that mean the provider (not the system) failed: such a run is retried, then excluded as infra error. */
export const INFRA_RULES = ["BUD_PROVIDER", "BUD_BREAKER", "BUD_TOTAL", "BUD_SPEND"];

interface Event {
  type: string;
  [k: string]: unknown;
}

export interface AidoOptions {
  env: Record<string, string | undefined>;
  ledger: SpendLedger;
  /** Scripted model for offline runs; omit to use Gemini from env. */
  llm?: Llm | null;
}

/** Runs one scenario end to end through the real HTTP + AG-UI surface of a fresh AIDO instance. */
export async function runAido(s: Scenario, o: AidoOptions): Promise<Omit<ScenarioResult, "attempts">> {
  const db = await scenarioDb(s);
  try {
    const { app } = await createServer(o.env, { db: db.sql, tools: withFailure(s), ledger: o.ledger, ...(o.llm !== undefined ? { llm: o.llm } : {}) });
    const call = (path: string, body: unknown, token?: string) =>
      app.handle(
        new Request(`http://eval${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(body),
        }),
      );
    const login = (await (await call("/api/auth/login", { persona: s.persona, pin: o.env.DEMO_PIN ?? "2468", language: s.language })).json()) as {
      token: string;
      sessionId: string;
    };
    const spentBefore = await o.ledger.total();
    const turns: TurnRecord[] = [];
    let pending: { id: string; nonce: string } | null = null;

    for (const step of s.steps) {
      let body: Record<string, unknown>;
      let input: string;
      if ("say" in step) {
        input = step.say;
        body = { messages: [{ id: crypto.randomUUID(), role: "user", content: step.say }] };
      } else {
        input = `[button: ${step.click}]`;
        // A click only exists in the UI while a confirmation is pending; otherwise there is nothing to press.
        if (!pending) {
          turns.push({ input, ruleIds: [], reply: "", ms: 0, interrupt: false, outcome: "no_pending_confirmation" });
          continue;
        }
        body = {
          messages: [],
          resume: [{ interruptId: pending.id, status: step.click === "confirm" ? "resolved" : "cancelled", payload: { nonce: pending.nonce, approved: step.click === "confirm" } }],
        };
      }
      const t0 = performance.now();
      const res = await call("/api/agui/run", { threadId: login.sessionId, runId: crypto.randomUUID(), ...body }, login.token);
      const events = (await res.text())
        .split("\n\n")
        .filter((b) => b.startsWith("data: "))
        .map((b) => JSON.parse(b.slice(6)) as Event);
      const ms = performance.now() - t0;
      const deltas = events.filter((e) => e.type === "STATE_DELTA").flatMap((e) => e.delta as { path: string; value: unknown }[]);
      const finished = events.find((e) => e.type === "RUN_FINISHED")?.outcome as { type: string; interrupts?: { id: string; metadata: { nonce: string }; message: string }[] } | undefined;
      const it = finished?.type === "interrupt" ? finished.interrupts?.[0] : undefined;
      pending = it ? { id: it.id, nonce: it.metadata.nonce } : null;
      const reply = [
        ...events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => String(e.delta)),
        ...(it ? [it.message] : []),
      ].join("\n");
      turns.push({
        input,
        outcome: String(deltas.find((d) => d.path === "/outcome")?.value ?? (res.ok ? "unknown" : `http_${res.status}`)),
        ruleIds: (deltas.find((d) => d.path === "/ruleIds")?.value as string[] | undefined) ?? [],
        reply,
        ms,
        interrupt: Boolean(it),
      });
    }

    const customerId = await customerOf(db.sql, s.persona);
    const fx = await effects(db.sql, customerId);
    const infra = turns.flatMap((t) => t.ruleIds).find((r) => INFRA_RULES.includes(r));
    return {
      scenarioId: s.id,
      system: "aido",
      turns,
      ...fx,
      costUsd: (await o.ledger.total()) - spentBefore,
      ...(infra ? { infraError: infra } : {}),
    };
  } finally {
    await db.close();
  }
}
