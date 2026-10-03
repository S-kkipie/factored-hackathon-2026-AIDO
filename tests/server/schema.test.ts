import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { withSchema } from "../../server/gates/schema";

const Slots = Type.Object(
  {
    merchant: Type.Optional(Type.String({ maxLength: 80 })),
    amount: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: false },
);

describe("withSchema", () => {
  test("accepts valid JSON on the first attempt", async () => {
    const r = await withSchema(Slots, async () => '{"merchant":"Uber","amount":30}');
    expect(r).toEqual({ ok: true, value: { merchant: "Uber", amount: 30 }, attempts: 1 });
  });

  test("retries once with the previous errors, then succeeds", async () => {
    const seen: string[][] = [];
    const r = await withSchema(Slots, async (attempt, errors) => {
      seen.push(errors);
      const fence = "`".repeat(3);
      return attempt === 1 ? '{"merchant":"Uber","customer_id":"CLI-X"}' : `${fence}json\n{"merchant":"Uber"}\n${fence}`;
    });
    expect(r).toEqual({ ok: true, value: { merchant: "Uber" }, attempts: 2 });
    expect(seen[1]?.length).toBeGreaterThan(0);
  });

  test("fails closed with SC_INVALID after the bounded attempts", async () => {
    const r = await withSchema(Slots, async () => "not json");
    expect(r).toMatchObject({ ok: false, ruleId: "SC_INVALID", attempts: 2 });
  });
});
