import { type BaseEvent, EventType } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { type TurnEvent, type CustomerSession, resumeTurn, runTurn, type TurnDeps } from "../graph/turn";

/**
 * Subset of AG-UI RunAgentInput the server reads. `tools`, `context`, `state` and `forwardedProps` are accepted on
 * the wire but ignored: the client never supplies tools, context or state to the agent (spec 9).
 */
export const RunInputSchema = Type.Object(
  {
    threadId: Type.String({ minLength: 1, maxLength: 100 }),
    runId: Type.String({ minLength: 1, maxLength: 100 }),
    messages: Type.Array(
      Type.Object({ role: Type.String(), content: Type.Optional(Type.Unknown()) }, { additionalProperties: true }),
      { maxItems: 200 },
    ),
    resume: Type.Optional(
      Type.Array(
        Type.Object(
          {
            interruptId: Type.String({ minLength: 1, maxLength: 100 }),
            status: Type.Union([Type.Literal("resolved"), Type.Literal("cancelled")]),
            payload: Type.Optional(Type.Unknown()),
          },
          { additionalProperties: true },
        ),
        { minItems: 1, maxItems: 1 },
      ),
    ),
  },
  { additionalProperties: true },
);

export type RunInput = typeof RunInputSchema.static;

/** Text of the last user message; only plain text parts are read. */
export function lastUserText(input: RunInput): string | null {
  const last = [...input.messages].reverse().find((m) => m.role === "user");
  if (!last) return null;
  if (typeof last.content === "string") return last.content;
  if (Array.isArray(last.content)) {
    return last.content
      .map((p) => (p && typeof p === "object" && (p as { type?: string }).type === "text" ? String((p as { text?: unknown }).text ?? "") : ""))
      .join("");
  }
  return null;
}

/** Maps turn events to AG-UI protocol events (spec 9): steps, state deltas, one text message, interrupt or success. */
export async function* toAgui(input: RunInput, events: AsyncIterable<TurnEvent>): AsyncGenerator<BaseEvent> {
  const { threadId, runId } = input;
  yield { type: EventType.RUN_STARTED, threadId, runId } as BaseEvent;
  yield { type: EventType.STATE_SNAPSHOT, snapshot: {} } as BaseEvent;
  let interrupt: Extract<TurnEvent, { type: "interrupt" }> | null = null;
  try {
    for await (const e of events) {
      switch (e.type) {
        case "step":
          yield { type: EventType.STEP_STARTED, stepName: e.name } as BaseEvent;
          yield { type: EventType.STEP_FINISHED, stepName: e.name } as BaseEvent;
          break;
        case "route":
          yield { type: EventType.STATE_DELTA, delta: [{ op: "add", path: "/route", value: { label: e.label, confidence: e.confidence } }] } as BaseEvent;
          break;
        case "decision":
          yield { type: EventType.STATE_DELTA, delta: [{ op: "add", path: "/decision", value: { action: e.action, ruleIds: e.ruleIds } }] } as BaseEvent;
          break;
        case "message": {
          const messageId = crypto.randomUUID();
          yield { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" } as BaseEvent;
          yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: e.text } as BaseEvent;
          yield { type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent;
          break;
        }
        case "view":
          yield { type: EventType.STATE_DELTA, delta: [{ op: "add", path: "/view", value: e.view }] } as BaseEvent;
          break;
        case "interrupt":
          interrupt = e;
          break;
        case "done":
          yield {
            type: EventType.STATE_DELTA,
            delta: [
              { op: "add", path: "/outcome", value: e.outcome },
              { op: "add", path: "/ruleIds", value: e.ruleIds },
              ...(e.caseId ? [{ op: "add", path: "/caseId", value: e.caseId }] : []),
              ...(e.handoffId ? [{ op: "add", path: "/handoffId", value: e.handoffId }] : []),
            ],
          } as BaseEvent;
          break;
      }
    }
  } catch {
    yield { type: EventType.RUN_ERROR, message: "The assistant could not complete this turn.", code: "internal" } as BaseEvent;
    return;
  }
  const outcome = interrupt
    ? {
        type: "interrupt",
        interrupts: [
          {
            id: interrupt.interruptId,
            reason: "confirm_dispute",
            message: interrupt.text,
            expiresAt: interrupt.expiresAt,
            metadata: { nonce: interrupt.nonce },
          },
        ],
      }
    : { type: "success" };
  yield { type: EventType.RUN_FINISHED, threadId, runId, outcome } as BaseEvent;
}

export type AguiError = { status: 400 | 403; ruleId: string; message: string };

/** Validates the body against the session and picks run vs resume. Returns an error or the turn events. */
export function startRun(
  deps: TurnDeps,
  session: CustomerSession,
  body: unknown,
): { error: AguiError } | { input: RunInput; events: AsyncIterable<TurnEvent> } {
  if (session.role !== "customer") return { error: { status: 403, ruleId: "IN_ROLE", message: "customer session required" } };
  if (!Value.Check(RunInputSchema, body)) return { error: { status: 400, ruleId: "IN_EMPTY", message: "invalid RunAgentInput" } };
  if (body.threadId !== session.sessionId) {
    return { error: { status: 403, ruleId: "IN_THREAD", message: "threadId must equal the session id" } };
  }
  const entry = body.resume?.[0];
  if (entry) {
    const payload = (entry.payload ?? {}) as { nonce?: unknown; approved?: unknown };
    const nonce = typeof payload.nonce === "string" ? payload.nonce : "";
    const approved = entry.status === "resolved" && payload.approved === true;
    return { input: body, events: resumeTurn(deps, session, { interruptId: entry.interruptId, nonce, approved }) };
  }
  const text = lastUserText(body);
  if (text === null) return { error: { status: 400, ruleId: "IN_EMPTY", message: "no user message" } };
  return { input: body, events: runTurn(deps, session, text) };
}

export function sseResponse(events: AsyncIterable<BaseEvent>, accept?: string): Response {
  const encoder = new EventEncoder({ accept });
  const bytes = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const e of events) controller.enqueue(bytes.encode(encoder.encodeSSE(e)));
        controller.close();
      } catch {
        // Client disconnected: enqueue/close throws once the controller is errored or closed. The for-await
        // loop's abrupt completion already called the events iterator's return(), so there is nothing left to
        // clean up here beyond not letting the exception become an unhandled rejection.
      }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}
