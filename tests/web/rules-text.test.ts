import { expect, test } from "bun:test";
import { RULE_IDS } from "../../server/rules";
import { RULE_TEXT } from "../../web/src/rules";

test("every rule id the server can emit has a description in the UI", () => {
  const missing = RULE_IDS.filter((id) => (RULE_TEXT[id]?.length ?? 0) <= 5);
  expect(missing).toEqual([]);
});
