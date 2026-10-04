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
3. **Automatic dispute intake allowed only if all hold:** transaction belongs to customer; status `Approved`; age ≤ 90 days; `amount_usd` ≤ 250; `fraud_score` < 30; not already disputed.
4. **Mandatory escalation if any holds:** `amount_usd` > 250; `fraud_score` ≥ 30 (suspected fraud; card block recommended, performed by human); ≥ 3 disputed transactions in one request; repeat complainer; customer status Suspended/Closed; explicit human request; tool failure after retries.
5. **Out-of-band confirmation** required before `create_dispute`: the graph interrupts and issues a single-use nonce; only a UI action carrying that nonce resumes the run. A typed "sí" in chat never confirms an action.
6. **No money movement.** The system never refunds, reverses, or blocks; it only creates cases and handoffs.
7. **Simulated clock** fixed at 2026-06-17 (last dataset date).
8. **Provenance.** Every state value carries its source (`jwt`, `db`, `user`, `llm`). Identity and ownership arguments to tools must come from `jwt` or `db`; dispute amount and merchant come from the transaction row, and the customer's own description is stored as an untrusted note (rule `PROV_001`).
9. **Commitments only from templates.** Timelines, outcomes and approvals ("your dispute was opened, reference D-123; review takes up to N business days") are rendered from policy-owned templates; the model may not state them in its own words.
10. **Budgets.** Per session: max 30 turns, max 3 LLM calls per turn, max 40k tokens; global daily spend cap. Exceeding any budget ends automation and escalates.

### 3.3 Handoff payload

JSON validated by schema: request summary, verified facts (with transaction ids), actions taken, triggering policy rule id(s), open questions, language, sentiment/urgency signal, session id. No raw transcript dump.

## 4. Architecture

### 4.1 Stack

| Layer | Choice |
|---|---|
| Runtime / API | Bun + Elysia (TypeBox schemas), typed fetch client over shared server types (plan 4 ruling: replaces Eden Treaty) |
| Orchestration | LangGraph JS (`@langchain/langgraph`), custom nodes only; no prebuilt ReAct agent |
| Generation / extraction | Gemini Flash (`@google/genai`), JSON output validated by schema |
| Intent routing | Best of 4 routers by evaluation (see §6); Jev (`@typesafe-ai/sdk`) candidate |
| Data pipeline | DuckDB (Node binding, fallback DuckDB CLI) over S3 CSV partitions |
| App data | `bun:sqlite`: read-only `serving.sqlite` + writable `ops.sqlite` |
| Frontend | React + Vite + TanStack Router |
| Agent ↔ UI protocol | AG-UI events over SSE (`@ag-ui/core`, `@ag-ui/encoder`; `@ag-ui/client` in the browser); no CopilotKit |
| Guardrail signal | Google Model Armor, inspect-only (prompt injection, sensitive data); never decides alone |
| Tracing | OpenTelemetry GenAI semantic conventions → Langfuse Cloud; hash-chained `audit_events` in SQLite as source of truth |
| Red teaming | promptfoo (ES/PT, OWASP LLM + Agentic plugins, multi-turn strategies) |
| Deploy | Single container on Google Cloud Run |

Everything is TypeScript. All code, identifiers, and documentation are in English; customer conversations are Spanish and Portuguese.

Compatibility risk: LangGraph JS and the DuckDB Node binding under Bun are verified first. Fallbacks: hand-written state machine with the same node contracts; DuckDB CLI.

### 4.2 Conversation graph

```
START → input_gate → budget_check → route ─┬─ low confidence → clarify → END
                                            ├─ out_of_scope   → abstain → END
                                            └─ intent         → extract_slots → schema_gate
                                  → policy ─┬─ escalate → handoff (interrupt) → END
                                            ├─ confirm  → confirm (interrupt + nonce) → tools
                                            └─ allow    → tools → verify → respond → response_gate → END
```

- Gemini is called only in `extract_slots`, `clarify`, and `respond`. `respond` may only use tool results and must cite transaction ids.
- All edges are deterministic code. The router supplies intent + confidence; the policy node supplies the decision + rule ids.
- State is persisted per session with a SQLite checkpointer in `ops.sqlite`.
- Nodes that run before an `interrupt()` have no side effects, because LangGraph re-runs the interrupted node on resume; writes happen in the node after the interrupt, guarded by idempotency keys.
- Session risk score: injection signals (Model Armor, heuristics), abstentions and policy denials accumulate per session; crossing the threshold routes to handoff (defense against multi-turn escalation).
- Context minimization: `extract_slots` sees only the current message and structured slots, never earlier raw model output.

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

### 4.5 Guardrail gates

| Gate | Mechanism | Stops | Rule prefix |
|---|---|---|---|
| 1 Input | JWT session, rate limit, size limit, PII masking, Model Armor inspect (signal), spotlighting/delimiting of untrusted data | expired/forged session, oversized input, PII to model | `IN_` |
| 1b Budget | turns, LLM calls, tokens, daily spend, circuit breaker on Gemini/Jev errors, `SAFE_MODE` kill switch (templates + escalation only) | unbounded consumption, provider outage | `BUD_` |
| 2 Router | intent + calibrated confidence, abstain below τ, session risk score | out-of-scope, ambiguity, multi-turn escalation | `RT_` |
| 3 Schema | TypeBox validation of model JSON, 1 retry, template fallback; provenance tagging of extracted slots as `llm` | malformed output, invented fields | `SC_` |
| 4 Policy | pure rules → allow / confirm / escalate; provenance check | injection-driven actions, unsafe automation | `POL_`, `PROV_` |
| 5 Tool | ownership from `jwt`/`db` only, allowlist (no money-moving tools exist), timeout, 2 retries, idempotency keys, nonce check on confirm | cross-customer access, duplicate writes | `TL_` |
| 6 Verify | read back created case by id; else handoff | silent tool failure | `VF_` |
| 7 Response | numbers/ids grounded in facts, commitments only from templates, canary token, output PII scan (Luhn cards, CPF, CURP, DNI), cross-customer leak scan, language check; dispute narrative escaped and flagged `untrusted` before storage | hallucination, prompt leakage, data leakage, stored injection | `RS_` |

Detection signals are logged and feed policy; no detector blocks or approves on its own. Gemini model versions are pinned and `safetySettings` set explicitly (`BLOCK_NONE` so scores are returned and logged). Threat mapping: OWASP LLM Top 10 2025 and OWASP Agentic Top 10 2026 (see `docs/research/2026-10-02-harness-guardrails-and-agui.md`).

## 5. Data pipeline

`bun run pipeline`:

```
S3 raw CSV (daily partitions)
  → raw/        idempotent local mirror
  → staging     typed, contract-validated, deduplicated (DuckDB)
       └→ rejects (primary key + reasons)
  → curated
       ├→ serving.sqlite   app subset
       └→ marts/*.parquet  demand evidence and operational baseline
  → reports/quality.md + runs/<run_id>/manifest.json
```

- **Contracts:** one TS module per table: columns, types, nullability, enums, PK uniqueness, FKs. Violations go to `rejects` with a reason.
- **Quality report:** duplicate rate (ID and content-level), null rates, orphans, enum violations, late-arrival lag (`process_date` vs event date), row counts vs documented.
- **Incremental load:** per-partition watermark, idempotent upsert. A labeled test fixture (late partition + corrected row) demonstrates update correctness.
- **Lineage:** curated rows carry `source_file` and `load_id`; manifest records input fingerprints (sha256 over relative path + size) and per-stage counts; an append-only load log keeps statistics across runs.
- **Serving subset:** ~2,000 customers stratified by country and segment, with products, last 180 days of transactions relative to the simulated clock, and complaints. Hand-picked demo users cover: normal, high amount, high fraud score, repeat complainer, suspended.
- **PII minimization:** LLM inputs contain only needed fields (merchant, amount, date, status); document numbers and contact data never reach serving.sqlite; customer names are masked in model inputs (serving keeps them for the UI). Serving tables are indexed by customer_id; `amount_usd` is null for ~2% of ARS/COP rows and policy treats null as escalate.
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

**Red teaming:** promptfoo with a custom provider that calls the graph and returns `{output, metadata: {rule_ids, decision, db_diff}}`; `language: [es, pt]`; frameworks `owasp:llm`, `owasp:agentic`; plugins `bola`, `bfla`, `rbac`, `pii`, `cross-session-leak`, `prompt-extraction`, `excessive-agency`, `hallucination`, `indirect-prompt-injection`, `hijacking` plus custom policies; strategies `crescendo`, `goat`, `hydra`, encodings. Suites: A deterministic gate tests; B fixed attack corpus tagged by OWASP id × language × turns; C benign and hard-benign set; D adaptive attacks plus one hour of manual red teaming, reported as a lower bound. Remote-inference strategies are disclosed.

**Security metrics:** attack success rate per class (Wilson CIs); share of blocked attacks where the expected rule fired; benign utility and utility under attack; false refusal rate; over-escalation; under-escalation (must be zero); pass^k (k = 4) for consistency. LLM judge is binary pass/fail, validated on 100–200 human labels with TPR/TNR and Cohen's κ ≥ 0.6.

**Execution:** `bun run eval` → `reports/eval.md` + raw JSON; `bun run redteam` → promptfoo report. Run sizes (full vs subset repeats) decided before running given cost (~$0.03 per scenario estimate).

## 8. Operations

- **Tracing:** OpenTelemetry spans following GenAI semantic conventions (pinned version): root `invoke_agent` (`gen_ai.conversation.id` = hashed session id), `chat` spans (model, token usage, finish reason), `execute_tool` spans, and one `bank.gate.*` span per gate (`id`, `rule_id`, `decision`, `reason_code`, `policy_version`, `signal_scores`, `latency_ms`). Content capture redacted. Exported to Langfuse Cloud (free tier) and mirrored to `ops.sqlite` for the trace view. OTel Node SDK under Bun is verified first; fallback is direct Langfuse SDK.
- **Audit:** append-only `audit_events` table with `prev_hash`/`hash` chain for every gate decision and action.
- **Explanations:** derived from sources, policy rules, and execution records; never from model chain-of-thought.
- **Fallbacks:** Jev failure → own router; router failure → clarify; Gemini failure → templated reply + handoff; circuit breaker opens on sustained provider errors; `SAFE_MODE` disables all model calls. Exceptions are never treated as low risk.
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

Transport: the chat streams AG-UI events from `POST /api/agui/run` (SSE). `STEP_STARTED/FINISHED` and `STATE_DELTA` drive a live status line ("checking policy…", router confidence, rule ids); interrupts arrive as `RUN_FINISHED` with an interrupt outcome and render as confirm/cancel cards carrying the nonce. The server ignores client-supplied `tools`, `context` and `state`, and requires `threadId` to equal the session id in the JWT. The agent console uses REST (`GET /api/agent/queue`, `POST /api/agent/sessions/:id/reply`, `POST /api/agent/sessions/:id/resume`, agent-role JWT); the trace view reads persisted spans with a plain GET.

No metrics dashboard; evaluation results live in `reports/eval.md`, README, and slides.

## 10. Deliverables

- Public repo `factored-hackathon-2026-AIDO` with reproducible setup (`bun install`, `bun run pipeline`, `bun run train`, `bun run eval`, `bun run dev`).
- Deployed Cloud Run URL.
- 4–6 slides; ≤ 3-minute video.
- Limitations section: synthetic data, no Portuguese source data, small evaluation samples, single-instance capacity, remaining deployment work.

## 11. Out of scope

Live banking integration, money movement, card blocking, credit decisions, streaming ingestion, voice, multi-agent setups, metrics dashboard, CopilotKit runtime and frontend tools.
