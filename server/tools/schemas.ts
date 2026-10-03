import { type Static, Type } from "@sinclair/typebox";

const IsoDate = Type.String({ pattern: String.raw`^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$` });

/** Filter accepted by searchTransactions. The customer is never part of the filter: it comes from the JWT. */
export const TxFilterSchema = Type.Object(
  {
    from: Type.Optional(IsoDate),
    to: Type.Optional(IsoDate),
    merchant: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    minUsd: Type.Optional(Type.Number()),
    maxUsd: Type.Optional(Type.Number()),
    limit: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

export const DisputeReasonSchema = Type.Union([
  Type.Literal("unrecognized"),
  Type.Literal("incorrect_amount"),
  Type.Literal("duplicate"),
]);
export type DisputeReason = Static<typeof DisputeReasonSchema>;

const Text = (maxLength: number) => Type.String({ maxLength });

/** Handoff payload (spec 3.3): structured facts for a human, never a raw transcript. */
export const HandoffCardSchema = Type.Object(
  {
    summary: Type.String({ minLength: 1, maxLength: 500 }),
    verifiedFacts: Type.Array(
      Type.Object(
        { kind: Text(40), id: Text(64), detail: Text(300) },
        { additionalProperties: false },
      ),
      { maxItems: 20 },
    ),
    actionsTaken: Type.Array(Text(200), { maxItems: 20 }),
    ruleIds: Type.Array(Type.String({ pattern: "^[A-Z]+_[A-Z0-9_]+$", maxLength: 40 }), { maxItems: 20 }),
    openQuestions: Type.Array(Text(300), { maxItems: 10 }),
    language: Type.Union([Type.Literal("es"), Type.Literal("pt")]),
    sentiment: Type.Optional(Text(40)),
  },
  { additionalProperties: false },
);
export type HandoffCard = Static<typeof HandoffCardSchema>;
