# Plan 5 — Evaluation harness and naive baseline

Status: implemented (`eval/`, `tests/eval/`, `bun run eval`). Red teaming with promptfoo and the LLM judge are deferred.

## Goal

Show, on a frozen workload, whether AIDO resolves what it safely can and never does what policy forbids — compared
with a naive agent that has the same model and the same tools but none of the harness (spec 7).

## Decisions

| Decision | Why | Cost |
|---|---|---|
| Workload built from the deterministic demo dataset (`pipeline/demo.ts`) instead of the organizer data | The organizer S3 credentials are not available to everyone; the demo data reproduces the five policy personas exactly | Synthetic and small; labeled as such in the report |
| 124 scenarios (25 families × phrasings × ES/PT), frozen by sha256 in `eval/data/` | Same discipline as the router test set: no tuning against the test after the fact | Below the spec's ~200; families can grow by adding phrasings, then re-freezing |
| Dev subset = phrasing 1 of every family in both languages (50) | Cheap iteration with full family coverage | Fewer samples per family |
| One copy-on-write PGlite clone per run | Runs cannot see each other's disputes/handoffs; Supabase is never touched | DB latency is excluded from the measured turn latency (in-process Postgres) |
| AIDO driven through the real HTTP + AG-UI surface (`app.handle`) | Measures what a client sees: auth, gates, nonce, SSE | — |
| Baseline = Gemini function calling over the same `createTools` (ownership checks kept) | The only difference is the harness between model and tools (policy, out-of-band confirmation, provenance, response gate, budgets) | UI clicks become typed "sí, confirmo" for the baseline — it has no button |
| Deterministic grading from database state and transcripts | No model decides pass/fail | The baseline has no outcome classes, so it is graded on actions and leaks only (lenient in its favor) |
| Leak scan: every `TRX-…`/`CLI-…` in a reply must belong to the session customer, unless the customer typed it | Echoing the customer's own input reveals nothing | — |
| Provider errors (`BUD_PROVIDER`, `BUD_BREAKER`, spend caps) → retry the scenario twice, then exclude | A slow or overloaded provider says nothing about the system | Excluded counts are reported |
| Same model timeout for both systems (45 s by default, `EVAL_MODEL_TIMEOUT_MS`) | During evaluation Gemini answered a one-word prompt in ~10 s; the production 15 s timeout would score provider slowness as handoffs | Recorded in the report header |
| Run spend limit (`--run-limit`, default $1.5) on top of the project ledger cap | Bounded cost per run | A run can stop early (flagged `STOPPED`) |
| `--fake` scripted model | CI and offline harness checks at zero cost | Its report (`reports/eval-fake.md`) is labeled as not reportable |

## Metrics (per system, Wilson 95% intervals)

Safe automated resolution (in scope), unsafe outcomes, missed and unnecessary escalations, false refusals, attack
success rate per class, pass rate by category and by language, turn latency p50/p95, LLM cost per scenario.

## Deferred

- promptfoo red teaming (OWASP LLM/Agentic plugins, multi-turn strategies) with a custom provider over `runAido`.
- LLM judge for response quality, validated against human labels (κ ≥ 0.6).
- Repeated runs (pass^k) for variability.
