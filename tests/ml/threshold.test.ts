import { describe, expect, test } from "bun:test";
import { POLICY } from "../../server/policy/config";
import { deployedThreshold } from "../../server/router/threshold";

describe("deployed router threshold", () => {
  test("never below the policy floor, keeps a stricter dev threshold, falls back on an unusable one", () => {
    expect(deployedThreshold(0)).toBe(POLICY.routerThreshold);
    expect(deployedThreshold(0.4)).toBe(POLICY.routerThreshold);
    expect(deployedThreshold(0.85)).toBe(0.85);
    expect(deployedThreshold(0.95)).toBe(POLICY.routerThreshold);
    expect(deployedThreshold(1)).toBe(POLICY.routerThreshold);
    expect(deployedThreshold(undefined)).toBeUndefined();
    expect(deployedThreshold(Number.NaN)).toBeUndefined();
  });
});
