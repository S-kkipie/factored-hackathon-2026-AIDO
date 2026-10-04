# Response-quality judge

Judge: Gemini (`gemini-3.8-flash`, rubric in `eval/judge.ts`) over final replies of the frozen test run `eval-2026-10-04T03-00-40-141Z`: 119 of 150 items judged. Deterministic pass/fail (reports/eval.md) is primary; this judge scores quality only.

## Judge pass rates

| System | grounded | language | tone | pass (all three) |
|---|---|---|---|---|
| proposed | 95.0% (88.8–97.8) · 95/100 | 100.0% (96.3–100.0) · 100/100 | 99.0% (94.6–99.8) · 99/100 | 95.0% (88.8–97.8) · 95/100 |
| baseline | 94.7% (75.4–99.1) · 18/19 | 100.0% (83.2–100.0) · 19/19 | 100.0% (83.2–100.0) · 19/19 | 94.7% (75.4–99.1) · 18/19 |

## Agreement with deterministic checks

Every judged item (the judge covered 119 of 150 before its spend limit), labeled by the system's own response gate with the customer's full records: grounded = no unsupported amount or unknown id; language = detected language matches the session; tone = no improvised commitment outside policy templates and no credential request (eval/deterministic-judge.ts). The problem statement allows validating a judge "against human or deterministic judgments".

| Criterion | n | agreement | Cohen's κ | TPR | TNR |
|---|---|---|---|---|---|
| grounded | 119 | 89.9% | -0.05 | 0.95 | 0.00 |
| language | 119 | 100.0% | n/a | 1.00 | n/a |
| tone | 119 | 98.3% | 0.49 | 1.00 | 0.33 |
| pass | 119 | 90.8% | 0.11 | 0.96 | 0.14 |

## Agreement with a second AI rater (not human)

The 50-item sample labeled by Claude (Anthropic), the same coding assistant that built the system, against the same rubric and evidence, without seeing the second-pass verdicts or which system answered (it had seen the discarded first pass in aggregate). This is model-to-model agreement, not independent, and NOT a human validation.

| Criterion | n | agreement | Cohen's κ | TPR | TNR |
|---|---|---|---|---|---|
| grounded | 33 | 100.0% | 1.00 | 1.00 | 1.00 |
| language | 33 | 100.0% | n/a | 1.00 | n/a |
| tone | 33 | 97.0% | 0.00 | 1.00 | 0.00 |
| pass | 33 | 97.0% | 0.65 | 1.00 | 0.50 |

## Reading

Overall-pass Cohen's κ by reference: deterministic checks: 0.11; a second AI rater (not human): 0.65. κ ≥ 0.6 is the bar for using the judge as a secondary quality signal.
TPR/TNR take the reference as truth (positive = pass).

- No human validation: spec 7 asks for human labels (about 50, ideally 100–200 for safety) with κ ≥ 0.6. That requirement is not met. The deterministic κ is below 0.6, and the AI rater's 0.65 rests on 2 negative labels in n = 33.
- The figures in these notes describe run eval-2026-10-04T03-00-40-141Z and judge v2026-10-04.2; recompute them after a rerun.
- Prevalence: almost every reply passes, so Cohen's κ is unstable (the kappa paradox): against the deterministic checks the judge agrees on 90.8% of items yet κ is low because the few negatives differ.
- Where they differ: the deterministic gate checks only amounts, ids, language and commitment wording; it flags ids the customer typed and translated statuses ("Aprobada", "Aprovada") that the judge accepts, and it cannot see invented non-numeric facts (branch hours, a merchant category) that the judge rejects. Case references (D-…, H-…) are removed before the check, so an invented reference is not caught.
- Evidence revision: a first judge pass (judge v2026-10-04.1) gave the judge only the transactions cited by id and no masked numbers, limits, times or channels; it marked 47% of proposed replies ungrounded for facts that were in the database. The evidence and rubric were corrected (v2026-10-04.2) before the results above; the first pass is kept in data/ and not reported as the result.
- Budget: the second pass stopped at its spend limit after 119 of 150 items (100 proposed, 19 baseline); 33 of the 50 sampled items were judged.

Limitations: the security grader (promptfoo) is not human-validated (see reports/redteam.md).
