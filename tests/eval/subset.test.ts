import { expect, test } from "bun:test";
import { baselineSubset } from "../../eval/main";
import type { Scenario } from "../../eval/scenario";

const s = (family: string, language: "es" | "pt", i: number) => ({ id: `${family}-${language}-${i}`, family, language }) as Scenario;

test("baselineSubset keeps ceil(share × n) per family and language, in order", () => {
  const all = [s("a", "es", 0), s("a", "es", 1), s("a", "es", 2), s("a", "es", 3), s("a", "pt", 0), s("b", "es", 0)];
  expect(baselineSubset(all, 0.75).map((x) => x.id)).toEqual(["a-es-0", "a-es-1", "a-es-2", "a-pt-0", "b-es-0"]);
  expect(baselineSubset(all, 1)).toEqual(all);
});
