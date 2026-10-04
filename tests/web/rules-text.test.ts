import { expect, test } from "bun:test";
import { RULE_IDS } from "../../server/rules";
import { RULE_TEXT, ruleText } from "../../web/src/lib/rules-text";

test("every rule id has a description, and unknown ids fall back to the id", () => {
  for (const id of RULE_IDS) expect(RULE_TEXT[id].length).toBeGreaterThan(5);
  expect(ruleText("POL_HUMAN")).toBe(RULE_TEXT.POL_HUMAN);
  expect(ruleText("XX_UNKNOWN")).toBe("XX_UNKNOWN");
});
