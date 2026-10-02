# AI-First Banking Customer Service — Design Spec

Team AIDO · Factored AI & Data Hackathon 2026 · 2026-10-02

## 1. Goal

Build a working, evaluated customer-service system for the synthetic LATAM Bank (Mexico, Colombia, Argentina) that serves customers in Spanish and Portuguese, resolves a focused workflow safely, abstains or clarifies when it should, and hands off to a human with structured context. The system must prove, on a held-out workload, that it improves on a baseline without unsafe outcomes, and must be honest about what remains before production.

Guiding principle: **AI understands and writes; deterministic code decides and acts.**

## 2. Problem evidence (from `docs/data_findings.md`)

- Contact mix (686,296 interactions): Transactional 35.0% (FCR 91.5%, 221 s), Complaint 17.1% (FCR 43.6%, 435 s).
- Complaints (67,095): "Cargo no reconocido" 18.3% and "Cobro indebido" 18.2% are the two largest subcategories; ~20% SLA breach; ~15.5 days to resolution; satisfaction ~3.0/5.
- Dataset limitations that shape the design: transcripts are templated (42 distinct customer texts, 2 base intents); transcript topic labels are unrelated to text (label purity 0.349); 0 Portuguese text; most outcome fields are flat across segments; `is_fraud` is a deterministic function of `fraud_score`; ~14% fewer rows than documented and no duplicate IDs.

Consequences: demand analysis uses the structured tables; the intent model is trained on team-generated, clearly labeled data; fraud handling is a deterministic rule.

## 3. Scope

**Workflow:** account and transaction inquiries with dispute intake for unrecognized or incorrect charges.

### 3.1 Intents

| Intent | Behavior |
|---|---|
| `check_balance` | Balance and available credit for an account or card owned by the session customer. |
| `list_transactions` | Transactions filtered by date range, merchant, or amount. |
| `explain_charge` | Identify one transaction; explain merchant, date, channel, status (Pending/Reversed/Declined). |
| `dispute_charge` | Identify transaction(s), capture reason (unrecognized / incorrect amount / duplicate), confirm, create dispute case, verify, return case id. |
| `request_human` | Explicit request for a human agent. |
| `out_of_scope` | Credit, app problems, branches, product opening, anything else: abstain and redirect. |

Greetings and thanks are answered without tools.

### 3.2 Policy (synthetic team policy, single config file)

1. **Identity.** Demo login (demo user + PIN) issues a signed JWT, 15-minute TTL. `customer_id` comes only from the session, never from message text. Expired session → re-authentication prompt, no data access.
2. **Data scope.** Every tool receives the session customer and checks ownership. References to other accounts or documents are denied and logged as unauthorized attempts.
3. **Automatic dispute intake allowed only if all hold:** transaction belongs to customer; status `Approved`; age ≤ 90 days; `amount_usd` ≤ 500; `fraud_score` < 30; not already disputed.
4. **Mandatory escalation if any holds:** `amount_usd` > 500; `fraud_score` ≥ 30 (suspected fraud; card block recommended, performed by human); ≥ 3 disputed transactions in one request; repeat complainer; customer status Suspended/Closed; explicit human request; tool failure after retries.
5. **Confirmation** required before `create_dispute` (graph interrupt).
6. **No money movement.** The system never refunds, reverses, or blocks; it only creates cases and handoffs.
7. **Simulated clock** fixed at 2026-06-17 (last dataset date).

### 3.3 Handoff payload

JSON validated by schema: request summary, verified facts (with transaction ids), actions taken, triggering policy rule id(s), open questions, language, sentiment/urgency signal, session id. No raw transcript dump.

## 4. Architecture

### 4.1 Stack

| Layer | Choice |
|---|---|
| Runtime / API | Bun + Elysia (TypeBox schemas), Eden Treaty typed client |
| Orchestration | LangGraph JS (`@langchain/langgraph`), custom nodes only; no prebuilt ReAct agent |
| Generation / extraction | Gemini Flash (`@google/genai`), JSON output validated by schema |
| Intent routing | Best of 4 routers by evaluation (see §6); Jev (`@typesafe-ai/sdk`) candidate |
| Data pipeline | DuckDB (Node binding, fallback DuckDB CLI) over S3 CSV partitions |
| App data | `bun:sqlite`: read-only `serving.sqlite` + writable `ops.sqlite` |
| Frontend | React + Vite + TanStack Router |
| Deploy | Single container on Google Cloud Run |

Everything is TypeScript. All code, identifiers, and documentation are in English; customer conversations are Spanish and Portuguese.

Compatibility risk: LangGraph JS and the DuckDB Node binding under Bun are verified first. Fallbacks: hand-written state machine with the same node contracts; DuckDB CLI.

### 4.2 Conversation graph

```
START → auth_check → route ─┬─ low confidence  → clarify → END
                            ├─ out_of_scope    → abstain → END
                            └─ intent          → extract_slots
                                  → policy ─┬─ escalate → handoff (interrupt) → END
                                            ├─ confirm  → confirm (interrupt) → tools
                                            └─ allow    → tools → verify → respond → END
```

- Gemini is called only in `extract_slots`, `clarify`, and `respond`. `respond` may only use tool results and must cite transaction ids.
- All edges are deterministic code. The router supplies intent + confidence; the policy node supplies the decision + rule ids.
- State is persisted per session with a SQLite checkpointer in `ops.sqlite`.

### 4.3 Tools (tool layer enforces authorization)

`get_accounts`, `get_balance`, `search_transactions`, `get_transaction`, `get_dispute_history`, `create_dispute` (idempotency key), `get_dispute`, `create_handoff`. Each has a TypeBox input/output contract, 3 s timeout, up to 2 retries with backoff (writes are idempotent so retries are safe).

### 4.4 Units

| Unit | Responsibility | Depends on |
|---|---|---|
| `pipeline/` | Download, contracts, staging, curation, quality report, manifest | S3, DuckDB |
| `server/auth` | Demo login, JWT issue/verify | — |
| `server/tools` | Data access with ownership checks | `serving.sqlite`, `ops.sqlite` |
| `server/policy` | Pure function: (intent, slots, facts, customer) → decision + rule ids | policy config |
| `server/router` | Intent classification behind one interface; implementations: keyword, Gemini zero-shot, embeddings+LR, Jev | model weights, APIs |
| `server/llm` | Gemini calls for extraction, clarification, response; prompt registry with versions | Gemini |
| `server/graph` | LangGraph wiring of the above | all server units |
| `server/trace` | Span recording, audit log, cost accounting | `ops.sqlite` |
| `web/` | Login, chat, agent console, trace viewer | Eden client |
| `ml/` | Utterance dataset build, training, router comparison | embeddings, APIs |
| `eval/` | Scenario runner, deterministic checks, LLM judge, report | running server |

## 5. Data pipeline

`bun run pipeline`:

```
S3 raw CSV (daily partitions)
  → raw/        idempotent local mirror
  → staging     typed, contract-validated, deduplicated (DuckDB)
       └→ rejects (row + reason)
  → curated
       ├→ serving.sqlite   app subset
       └→ marts/*.parquet  demand evidence and operational baseline
  → reports/quality.md + runs/<run_id>/manifest.json
```

- **Contracts:** one TS module per table: columns, types, nullability, enums, PK uniqueness, FKs. Violations go to `rejects` with a reason.
- **Quality report:** duplicate rate (ID and content-level), null rates, orphans, enum violations, late-arrival lag (`process_date` vs event date), row counts vs documented.
- **Incremental load:** per-partition watermark, idempotent upsert. A labeled test fixture (late partition + corrected row) demonstrates update correctness.
- **Lineage:** curated rows carry `source_file` and `load_id`; manifest records input hashes and per-stage counts.
- **Serving subset:** ~2,000 customers stratified by country and segment, with products, last 180 days of transactions relative to the simulated clock, and complaints. Hand-picked demo users cover: normal, high amount, high fraud score, repeat complainer, suspended.
- **PII minimization:** LLM inputs contain only needed fields (merchant, amount, date, status); document numbers and contact data never leave the server; names masked.
- **Restricted data:** dataset files and `serving.sqlite` are never committed to the public repository.

## 6. ML component: intent router

**Data**

| Set | Source | Size |
|---|---|---|
| train/dev | Hand-written seed utterances per intent × language (ES-MX/CO/AR, PT-BR) incl. hard negatives, expanded by Gemini paraphrase (prompt and model version logged) | ~150 per intent per language |
| test | Written by a separate process without the train generator; all labels validated by the team member | ~240 (≈20 per intent per language) |

All utterance data is labeled as team-generated synthetic.

**Leakage prevention:** split by seed-template family; remove test items with cosine similarity > 0.95 to any train item; freeze test by hash before any model selection.

**Routers compared on the same test set**

0. Keyword/regex baseline (ES + PT lexicons).
1. Gemini Flash zero-shot (JSON).
2. Gemini embeddings + multinomial logistic regression with L2, trained in TS; weights versioned as JSON.
3. Jev `choice` with calibrated probabilities.

**Abstention:** confidence threshold chosen on dev for ≤ 2% misroutes among accepted predictions; below threshold → clarify. Report coverage-accuracy curve.

**Metrics:** macro-F1, per-intent F1, per-language F1, confusion matrix, `out_of_scope` recall (safety), calibration, latency, cost per classification; bootstrap confidence intervals.

**Selection:** the deployed router is chosen on the accuracy / `out_of_scope` recall / calibration / latency / cost trade-off, with the rationale reported even if a non-trained model wins.

**Tracking:** each run writes `experiments/<run_id>.json` (data hash, model version, metrics).

## 7. System evaluation

**Workload:** ~200 multi-turn scripted scenarios, half ES, half PT, each with a gold outcome (auto-resolve / clarify / abstain / escalate), expected tool calls, forbidden actions, expected rule ids. Separate small dev set for iteration; test frozen by hash.

| Category | Share |
|---|---|
| Normal | 35% |
| Ambiguous / clarify | 15% |
| Out of scope | 10% |
| Must escalate | 15% |
| Adversarial: direct injection, indirect injection via data fields (e.g. `merchant_name`), cross-customer access, expired session | 10% |
| Failures: injected tool timeouts/errors, null or duplicate data | 10% |
| Multilingual ambiguity: Portuñol, mid-conversation switch, regionalisms | 5% |

**Grading**
- Primary: deterministic checks on traces and `ops.sqlite`: outcome class, tool calls, policy decision and rule ids, dispute existence, data-leak scan for other customers' identifiers and amounts.
- Secondary: LLM judge for groundedness, language correctness, tone, with a written rubric; validated against human labels on ~50 responses, agreement reported.

**Baseline:** naive agent = Gemini function calling over the same tools without the policy layer, same scenarios.

**Metrics:** safe automated resolution rate over in-scope cases and share of cases with automation attempted; containment (reported separately); escalation quality (missed and unnecessary); unsafe outcomes with counts and denominators; p50/p95 end-to-end latency; cost per attempted case and per successful automated resolution ("not defined" if none); breakdowns by language and segment with small-sample caveats; repeated-run variability; model and prompt versions.

**Business projection:** agent-minutes saved projected from Transactional volume and duration, labeled as projection, never as measured improvement.

**Execution:** `bun run eval` → `reports/eval.md` + raw JSON. Run sizes (full vs subset repeats) decided before running given cost (~$0.03 per scenario estimate).

## 8. Operations

- **Tracing:** per-node spans (redacted input/output, latency, tokens, cost, model/prompt version, intent + confidence, policy rule ids) in `ops.sqlite`; append-only audit log for actions.
- **Explanations:** derived from sources, policy rules, and execution records; never from model chain-of-thought.
- **Fallbacks:** Jev failure → own router; router failure → clarify; Gemini failure → templated reply + handoff. Exceptions are never treated as low risk.
- **Security:** JWT sessions; tool-level authorization; untrusted data delimited and marked as data in prompts; injection signal from router/Jev feeds policy (never decides alone); per-session rate limit; secrets in GCP Secret Manager; 30-day retention for conversations and traces (configurable).
- **Capacity:** writable state in container-local SQLite → Cloud Run `max-instances=1`. Documented limit; production path is Postgres/Cloud SQL.
- **CI/CD:** GitHub Actions runs tests and lint on synthetic fixtures (no S3). Image built locally or via Cloud Build, pushed to Artifact Registry, deployed with `bun run deploy`.

## 9. UI

| Route | Purpose |
|---|---|
| `/login` | Choose demo user (with scenario hint) and language |
| `/chat` | Customer chat; confirm/cancel buttons on interrupts; case number display |
| `/agent` | Handoff queue and handoff card; human takes over and replies, graph resumes |
| `/trace/:session` | Per-turn timeline: router, confidence, policy, tools, latency, cost |

No metrics dashboard; evaluation results live in `reports/eval.md`, README, and slides.

## 10. Deliverables

- Public repo `factored-hackathon-2026-AIDO` with reproducible setup (`bun install`, `bun run pipeline`, `bun run train`, `bun run eval`, `bun run dev`).
- Deployed Cloud Run URL.
- 4–6 slides; ≤ 3-minute video.
- Limitations section: synthetic data, no Portuguese source data, small evaluation samples, single-instance capacity, remaining deployment work.

## 11. Out of scope

Live banking integration, money movement, card blocking, credit decisions, streaming ingestion, voice, multi-agent setups, metrics dashboard.
