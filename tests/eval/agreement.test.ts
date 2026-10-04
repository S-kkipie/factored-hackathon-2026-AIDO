import { expect, test } from "bun:test";
import { agreement, cohenKappa } from "../../eval/agreement";

test("Cohen's kappa matches a hand-computed case and handles degenerate input", () => {
  // 10 pairs: both pass 6, both fail 2, human pass/judge fail 1, human fail/judge pass 1 → po 0.8, pe 0.7·0.7+0.3·0.3 = 0.58, κ = 0.22/0.42.
  const pairs: [boolean, boolean][] = [
    ...Array(6).fill([true, true]),
    ...Array(2).fill([false, false]),
    [true, false],
    [false, true],
  ];
  expect(cohenKappa(pairs)!).toBeCloseTo(0.22 / 0.42, 6);
  expect(cohenKappa([])).toBeNull();
  expect(cohenKappa([[true, true], [true, true]])).toBeNull();
  const a = agreement(pairs);
  expect(a).toMatchObject({ n: 10, agree: 8 });
  expect(a.tpr).toBeCloseTo(6 / 7, 6);
  expect(a.tnr).toBeCloseTo(2 / 3, 6);
});
