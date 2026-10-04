# Intent router comparison

Run `router-2026-10-03T23-40-44-492Z` · test set 237 hand-written utterances (frozen, hash `00b8259dd350`) · train 860 / dev 173 (hand-written seeds + Gemini paraphrases) · spend this run $0.101280.

All utterances are team-generated synthetic data (spec 6). Numbers are measured on the frozen test set; thresholds were chosen on dev; the selection rule used test metrics (rule fixed before evaluation).

| Router | Macro-F1 (95% CI) | F1 ES | F1 PT | out_of_scope recall | OOS safe rate | Failures | ECE | Threshold | Coverage @τ | Misroutes @τ | p50 / p95 ms | USD / classification |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| keyword | 0.631 (0.569–0.684) | 0.633 | 0.625 | 0.353 | 1.000 | 119 | 0.041 | 1.00 | 0.000 | 0.000 | 0 / 0 | $0 |
| embed-lr **(selected)** | 0.975 (0.952–0.992) | 0.957 | 0.992 | 1.000 | 1.000 | 0 | 0.021 | 0.00 | 1.000 | 0.025 | 739 / 1566 | $0.000002 |
| gemini-zeroshot | 1.000 (1.000–1.000) | 1.000 | 1.000 | 1.000 | 1.000 | 0 | 0.017 | 0.00 | 1.000 | 0.000 | 1256 / 2322 | $0.000323 |

`out_of_scope recall` is the plain per-class recall (a confidence-0 abstention never counts as a hit). `OOS safe rate` is the field the selection rule uses: gold out_of_scope rows that are either predicted out_of_scope at or above the router's own threshold, or below it (would clarify, which is still safe).

**Selected:** embed-lr. embed-lr has test macro-F1 0.975 and out_of_scope safe rate 1.000; it meets the 0.8 out_of_scope safe rate floor; gemini-zeroshot scored macro-F1 1.000 but is not deployable within the 3-calls-per-turn budget.

**Deployed threshold:** 0.60 (dev threshold 0.00, floored at the policy's 0.6; a dev threshold ≥ 0.95 falls back to it) — on the test set: coverage 1.000, misroutes 0.025.

## Per-intent F1

| Intent | keyword | embed-lr | gemini-zeroshot |
|---|---|---|---|
| check_balance | 0.780 | 1.000 | 1.000 |
| list_transactions | 0.553 | 0.958 | 1.000 |
| explain_charge | 0.419 | 0.923 | 1.000 |
| dispute_charge | 0.847 | 0.955 | 1.000 |
| request_human | 0.741 | 1.000 | 1.000 |
| out_of_scope | 0.511 | 0.986 | 1.000 |
| greeting | 0.565 | 1.000 | 1.000 |

## Confusion matrix — embed-lr (rows: gold, columns: predicted)

| | check_balance | list_transactions | explain_charge | dispute_charge | request_human | out_of_scope | greeting |
|---|---|---|---|---|---|---|---|
| check_balance | 34 | 0 | 0 | 0 | 0 | 0 | 0 |
| list_transactions | 0 | 34 | 0 | 0 | 0 | 0 | 0 |
| explain_charge | 0 | 3 | 30 | 1 | 0 | 0 | 0 |
| dispute_charge | 0 | 0 | 1 | 32 | 0 | 1 | 0 |
| request_human | 0 | 0 | 0 | 0 | 34 | 0 | 0 |
| out_of_scope | 0 | 0 | 0 | 0 | 0 | 34 | 0 |
| greeting | 0 | 0 | 0 | 0 | 0 | 0 | 33 |

## Coverage curve — embed-lr

| Threshold | Coverage | Misroute rate |
|---|---|---|
| 0.00 | 1.000 | 0.025 |
| 0.05 | 1.000 | 0.025 |
| 0.10 | 1.000 | 0.025 |
| 0.15 | 1.000 | 0.025 |
| 0.20 | 1.000 | 0.025 |
| 0.25 | 1.000 | 0.025 |
| 0.30 | 1.000 | 0.025 |
| 0.35 | 1.000 | 0.025 |
| 0.40 | 1.000 | 0.025 |
| 0.45 | 1.000 | 0.025 |
| 0.50 | 1.000 | 0.025 |
| 0.55 | 1.000 | 0.025 |
| 0.60 | 1.000 | 0.025 |
| 0.65 | 1.000 | 0.025 |
| 0.70 | 0.996 | 0.021 |
| 0.75 | 0.992 | 0.017 |
| 0.80 | 0.983 | 0.013 |
| 0.85 | 0.975 | 0.004 |
| 0.90 | 0.970 | 0.000 |
| 0.95 | 0.962 | 0.000 |
| 1.00 | 0.000 | 0.000 |

## Leakage drop by (label, language)

| Group | Kept | Dropped | Dropped share |
|---|---|---|---|
| check_balance / es | 47 | 35 | 0.427 |
| check_balance / pt | 47 | 33 | 0.412 |
| dispute_charge / es | 82 | 2 | 0.024 |
| dispute_charge / pt | 83 | 1 | 0.012 |
| explain_charge / es | 84 | 0 | 0.000 |
| explain_charge / pt | 84 | 0 | 0.000 |
| greeting / es | 78 | 3 | 0.037 |
| greeting / pt | 69 | 6 | 0.080 |
| list_transactions / es | 78 | 6 | 0.071 |
| list_transactions / pt | 80 | 4 | 0.048 |
| out_of_scope / es | 80 | 1 | 0.012 |
| out_of_scope / pt | 73 | 6 | 0.076 |
| request_human / es | 77 | 6 | 0.072 |
| request_human / pt | 71 | 10 | 0.123 |

## Method

- Embeddings: `gemini-embedding-001`, 768 dimensions, L2-normalized; multinomial logistic regression with L2 = 0.0001 chosen on dev (0.0001: 0.994, 0.001: 0.977, 0.01: 0.959), temperature 0.3 fitted on dev.
- Leakage control: split by seed family, ES/PT translation pairs kept together (14 dev families); 113 training rows with cosine > 0.95 to any test row were dropped; the test set is frozen by hash.
- Thresholds: lowest confidence whose accepted dev predictions misroute ≤ 2%; below it the assistant asks a clarifying question.
- Selection rule fixed before evaluation: deployable routers only (≤ 3 chat calls per turn), out_of_scope safe rate ≥ 0.8, then highest macro-F1, cheaper router on a gap < 0.01; the selection rule used test metrics (rule fixed before evaluation).
- The gemini-zeroshot threshold was chosen on a stratified dev sample of 70 rows.
- Limitations: the test set and the seeds were written by the same author (the coding assistant) and validated by the team member; small test set (wide CIs); Jev was not evaluated.
