import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RULE_IDS, isRuleId } from "../../server/rules";

const PREFIXES = /^(IN|BUD|RT|SC|POL|PROV|TL|VF|RS|RSK)_[A-Z0-9_]+$/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

describe("rule id registry", () => {
  test("every registered id uses an allowed prefix and is unique", () => {
    for (const id of RULE_IDS) expect(id).toMatch(PREFIXES);
    expect(new Set(RULE_IDS).size).toBe(RULE_IDS.length);
  });

  test("every rule id literal in server/ is registered", () => {
    const root = join(import.meta.dir, "../../server");
    const used = new Set<string>();
    for (const file of sources(root)) {
      for (const m of readFileSync(file, "utf8").matchAll(/["'`]((?:IN|BUD|RT|SC|POL|PROV|TL|VF|RS|RSK)_[A-Z0-9_]*[A-Z0-9])(?![A-Z0-9_$])/g)) {
        used.add(m[1]!);
      }
    }
    expect(used.size).toBeGreaterThan(40);
    expect([...used].filter((id) => !isRuleId(id))).toEqual([]);
  });

  test("isRuleId rejects unknown ids", () => {
    expect(isRuleId("POL_DSP_OK")).toBe(true);
    expect(isRuleId("POL_MADE_UP")).toBe(false);
  });
});
