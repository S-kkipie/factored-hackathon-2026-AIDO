import { Annotation } from "@langchain/langgraph";
import { type Static, Type } from "@sinclair/typebox";
import type { Language } from "../auth";
import type { Product, Transaction } from "../db/serving";
import type { Decision } from "../policy/rules";
import type { Val } from "../provenance";
import type { RouteResult } from "../router/types";
import type { RuleId } from "../rules";
import type { Dispute } from "../tools";
import { DisputeReasonSchema } from "../tools/schemas";

const IsoDay = Type.String({ pattern: String.raw`^\d{4}-\d{2}-\d{2}$` });

/** Gate 3 contract for extract_slots output. Unknown fields fail validation. */
export const SlotsSchema = Type.Object(
  {
    transactionIds: Type.Optional(Type.Array(Type.String({ pattern: "^TRX-[A-Z0-9]{6,24}$" }), { maxItems: 5 })),
    merchant: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    date: Type.Optional(IsoDay),
    from: Type.Optional(IsoDay),
    to: Type.Optional(IsoDay),
    amount: Type.Optional(Type.Number({ minimum: 0 })),
    reason: Type.Optional(DisputeReasonSchema),
    note: Type.Optional(Type.String({ maxLength: 300 })),
  },
  { additionalProperties: false },
);
export type Slots = Static<typeof SlotsSchema>;

/** Gate 3 contract for the respond call. */
export const ReplySchema = Type.Object({ reply: Type.String({ minLength: 1, maxLength: 1500 }) }, { additionalProperties: false });

export interface ToolResults {
  products?: Val<Product[]>;
  transactions?: Val<Transaction[]>;
  dispute?: Val<Dispute>;
}

export type Outcome = "greeting" | "clarify" | "abstain" | "answered" | "handoff" | "dispute_created" | "cancelled";

/** Answer the turn runner passes when resuming a confirmation interrupt (never client-supplied as-is). */
export interface Confirmation {
  approved: boolean;
  interruptId: string;
  /**
   * sha256(canonicalJson(confirmPayload(state))) at resume time, rebuilt from the checkpoint. `create_dispute`
   * recomputes this from its own state and refuses to write on any mismatch (fix round 1: a keyed Command resume
   * already scopes this answer to its own interrupt task, and this hash is the second, independent check).
   */
  payloadHash: string;
}

/** Value carried by the confirmation interrupt; `payload` is what the nonce is bound to. */
export interface ConfirmInterrupt {
  kind: "confirm_dispute";
  payload: { transactionIds: string[]; reason: string };
  text: string;
}

/**
 * Per-turn graph state. Every field is last-value and the turn runner resets all of them at the start of a turn,
 * so nothing from an earlier turn leaks into the next one (context minimization, spec 4.2). Text is already
 * PII-masked by the input gate before it enters the state.
 */
export const TurnState = Annotation.Root({
  message: Annotation<string>(),
  language: Annotation<Language>(),
  injection: Annotation<boolean>(),
  route: Annotation<RouteResult | null>(),
  slots: Annotation<Val<Slots> | null>(),
  targets: Annotation<Val<Transaction>[]>(),
  candidates: Annotation<Transaction[]>(),
  decision: Annotation<Decision | null>(),
  results: Annotation<ToolResults>(),
  /** Set by a node that cannot continue safely; the next edge goes to handoff. */
  forceHandoff: Annotation<boolean>(),
  confirmation: Annotation<Confirmation | null>(),
  ruleIds: Annotation<RuleId[]>(),
  outcome: Annotation<Outcome | null>(),
  reply: Annotation<string>(),
  handoffId: Annotation<string | null>(),
});

export type TurnValues = typeof TurnState.State;
export type TurnUpdate = typeof TurnState.Update;

export function freshTurn(message: string, language: Language, injection: boolean): TurnValues {
  return {
    message,
    language,
    injection,
    route: null,
    slots: null,
    targets: [],
    candidates: [],
    decision: null,
    results: {},
    forceHandoff: false,
    confirmation: null,
    ruleIds: [],
    outcome: null,
    reply: "",
    handoffId: null,
  };
}
