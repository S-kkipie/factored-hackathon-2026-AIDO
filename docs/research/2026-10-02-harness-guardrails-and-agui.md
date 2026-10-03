# Research: agent harness, guardrails, CopilotKit and AG-UI

2026-10-02 · Team AIDO. Items marked **[UNVERIFIED]** were not confirmed against a primary source.

## 1. Guardrails: gaps against our 7 gates

Frameworks: OWASP Top 10 for LLM Applications 2025 (LLMxx), OWASP Top 10 for Agentic Applications 2026 (ASIxx), NIST AI 600-1, MITRE ATLAS.

| # | Gap | Mapping | Gate | Severity |
|---|---|---|---|---|
| 1 | Identity/ownership fields can originate from user text or LLM extraction; ownership check validates the wrong subject. Need provenance per value (`jwt`, `db`, `user`, `llm`). | ASI03, CaMeL | 3/4/5 | Critical |
| 2 | Confirmation parsed from chat text can be confirmed by an injection; must be an out-of-band UI action with a server-issued single-use nonce. | ASI01, LLM06 | 4/5 | High |
| 3 | No token / turn / LLM-call / spend budgets; no circuit breaker or kill switch. | LLM10 | 1 + ops | High |
| 4 | Response gate grounds numbers and ids but not commitments ("refund in 5 days", "dispute approved"). | LLM09, NIST confabulation | 7 | High |
| 5 | Customer dispute narrative stored raw: stored injection for downstream humans/LLMs. | LLM05, ASI09 | 6/7 | Med-High |
| 6 | Multi-turn escalation (Crescendo) and history poisoning; gates judge single turns. | ASI06 | 2/3 | Med-High |
| 7 | No system-prompt leakage check. | LLM07 | 7 | Med |
| 8 | PII captured in traces/logs. | LLM02 | tracing | Med |
| 9 | Unpinned model aliases; Gemini 2.5/3 safety filters default to OFF (no scores returned). | LLM03 | 3/ops | Med |
| 10 | Handoff queue/state/SLA undefined. | NIST human-AI configuration | 4 | Med |
| 11 | Router calibration (Jev) is a vendor claim; verify with reliability plot on our ES/PT data. | — | 2 | Med |

Baseline confirmations: adaptive attacks broke 12 published injection defenses at >90% success ("The Attacker Moves Second"), so detectors must stay signals. Our design matches Meta's "Agents Rule of Two" and the action-selector / context-minimization patterns recommended for customer-service agents in "Design Patterns for Securing LLM Agents against Prompt Injections" (§4.4). Full CaMeL is overkill (custom interpreter; 77% vs 84% utility on AgentDojo).

## 2. Ranked improvements (solo, ~1–2 weeks)

1. **Typed provenance (lightweight CaMeL)** — every state value `{v, src}`; tool gate rejects identity/ownership args with `src ∉ {jwt, db}`; dispute amount/merchant taken from the DB row, user claim kept as note. Rule `PROV_001`.
2. **Out-of-band confirmation** — `interrupt()` returns a server-issued single-use nonce; UI button resumes with it; server validates nonce + interrupt id. LangGraph re-runs the interrupted node on resume, so side effects before `interrupt()` must be idempotent or moved to the next node.
3. **Budgets, circuit breaker, kill switch** — per-session max turns, max LLM calls per turn (3), max tokens; global daily spend cap; breaker on Gemini/Jev error or latency rate → template/escalate path; `SAFE_MODE` env = no LLM.
4. **Stronger response gate** — commitments only from template slots (ES/PT promise-phrase detector blocks others); canary token in system prompt; output PII scan (Luhn card numbers, CPF, CURP, DNI); dispute narrative escaped and stored with `untrusted` flag.
5. **Context minimization + session risk score** — extraction sees only current message + structured slots; injection/abstain signals accumulate per session; threshold escalates.
6. **One external detector: Google Model Armor (inspect-only)** — REST; prompt-injection/jailbreak, Sensitive Data Protection, RAI filters; ES/PT tested; first 2M tokens/month free, then $0.10/M. Signal only. Latency ~50–200 ms same region per third-party blog **[UNVERIFIED]**. Alternative: Llama Prompt Guard 2 86M (multilingual, CPU latency on Cloud Run **[UNVERIFIED]**). Not chosen: NeMo Guardrails (Python service), Guardrails AI (JS is a Python bridge), Lakera (vendor-only figures).
7. **promptfoo red-team suite wired to rule ids** — see §3.
8. **OpenTelemetry GenAI tracing + hash-chained audit table** — see §4. Pin exact Gemini model version; set `safetySettings` explicitly (`BLOCK_NONE` still returns scores).

## 3. Evaluation and red teaming

Tool: **promptfoo** (TypeScript-native, open source after OpenAI acquisition announced 2026-03-09).
- Custom provider calls the graph, returns `{output, metadata: {rule_ids, decision, db_diff}}`.
- `redteam.language: [es, pt]`, banking `purpose`, `frameworks: [owasp:llm, owasp:agentic]`.
- Plugins: `bola`, `bfla`, `rbac`, `pii:*`, `cross-session-leak`, `prompt-extraction`, `excessive-agency`, `hallucination`, `indirect-prompt-injection`, `hijacking`, plus custom policies ("never promise refund timelines", "never reveal another customer's data").
- Strategies: `crescendo`, `goat`, `hydra`, encodings (base64, homoglyph). Some strategies use promptfoo remote inference in Community edition: acceptable with synthetic data, disclose.

Suite structure: A deterministic gate unit tests; B fixed attack corpus tagged OWASP LLM/ASI (and ATLAS **[UNVERIFIED]** ids) × language (es, pt, mixed, English inside Spanish) × turns; C benign and hard-benign set (legitimate requests that look like attacks); D adaptive attacks plus one hour of human red teaming, reported as a lower bound on attack success.

Metrics: targeted attack success rate per class with Wilson CIs; share of blocked attacks where the expected rule fired; benign utility and utility under attack (AgentDojo); false refusal rate; over-escalation; under-escalation (hard zero gate); task success checked against DB state (tau-bench style); pass^k with k = 4–8; p95 latency and cost per conversation. Judge: prefer deterministic assertions; LLM judge binary pass/fail, 100–200 human labels, report TPR/TNR, require Cohen's κ ≥ 0.6.

## 4. Tracing

- Root `invoke_agent` span (`gen_ai.conversation.id` = hashed session id); `chat` spans (`gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens/output_tokens`, finish reasons); `execute_tool` spans (`gen_ai.tool.name`, call id, idempotency key); one span per gate in custom namespace `bank.gate.*` (`id`, `rule_id`, `decision`, `reason_code`, `policy_version`, `signal_scores`, `latency_ms`).
- `gen_ai.*` conventions are "Development" stability (moved to `semantic-conventions-genai`): pin a version. Content capture off or redacted.
- Backend: Langfuse Cloud Hobby (50k units/month, 30-day retention). Self-hosted Langfuse v3 needs ClickHouse/Redis/Postgres/S3; Phoenix is a local alternative. OTel Node SDK under Bun **[UNVERIFIED]**: test day one.
- Source of truth: append-only SQLite `audit_events` with `prev_hash`/`hash`.
- LangGraph JS middleware (`beforeModel`, `wrapToolCall`, built-in PII/HITL) applies only to `createAgent`; our custom StateGraph with gate nodes is the right shape. Built-in PII middleware does not cover CPF/CURP.

## 5. CopilotKit and AG-UI

**AG-UI**: open MIT event protocol (ag-ui-protocol org). `@ag-ui/core`, `@ag-ui/client`, `@ag-ui/encoder` at 1.0.1 (2026-09-29). Events: `RUN_STARTED/FINISHED/ERROR`, `STEP_STARTED/FINISHED`, `TEXT_MESSAGE_*`, `TOOL_CALL_*`, `STATE_SNAPSHOT`, `STATE_DELTA` (JSON Patch), `MESSAGES_SNAPSHOT`, `CUSTOM`. Interrupts: `RUN_FINISHED.outcome = {type: "interrupt", interrupts: [{id, reason, message, responseSchema, expiresAt, metadata}]}`; client resumes with `resume: [{interruptId, status, payload}]`. Transport: POST `RunAgentInput` → SSE. Some lifecycle extensions still draft; structured interrupts new.

**CopilotKit** (MIT, React 1.77.0; v2 hooks `useAgent`, `useInterrupt`, `useFrontendTool`): the LangGraph JS adapter (`@ag-ui/langgraph` 0.0.44 `LangGraphAgent`) requires a LangGraph Agent Server (`deploymentUrl`, `graphId`); no in-process adapter for a compiled StateGraph inside our own server (maintainers, June 2026). Runtime is heavy (GraphQL Yoga, type-graphql, Segment analytics), telemetry on by default (`COPILOTKIT_TELEMETRY_DISABLED=true`), `@scarf/scarf` install analytics, license-token check in runtime. `useFrontendTool` lets the agent call browser functions: conflicts with "LLM never calls tools".

**Decision: AG-UI protocol only (option B).** Elysia emits AG-UI events over SSE; our React UI consumes them with `@ag-ui/client` `HttpAgent`. Effort ~1.5–2.5 days vs ~4–6 for full CopilotKit; low lock-in.

Integration sketch:
- `POST /api/agui/run` (JWT required): body `RunAgentInput`; `threadId` must equal session id from JWT; ignore client `tools`, `context`, `state`; user text from last message.
- `graph.stream(input | new Command({resume}), {configurable: {thread_id}, streamMode: ["updates", "messages", "custom"]})` → `RUN_STARTED`; per node `STEP_STARTED/FINISHED` + `STATE_DELTA` (`stage`, `routerConfidence`, `ruleIds`); `CUSTOM` via `config.writer`; Gemini tokens → `TEXT_MESSAGE_*`; on interrupt → `RUN_FINISHED` with interrupt outcome (`reason: "confirmation"`, `responseSchema: {approved: boolean}`, `metadata: {disputeDraft, nonce}`).
- Resume: validate `interruptId` + nonce against `graph.getState()` before `Command({resume})`.
- Handoff: interrupt `reason: "input_required"` + `metadata.handoffCard`; queue table; agent console uses REST (`GET /api/agent/queue`, `POST /api/agent/sessions/:id/reply`, `POST /api/agent/sessions/:id/resume`, agent-role JWT).
- `/trace` reads persisted spans via plain GET.

## Sources

- OWASP LLM Top 10 2025: https://genai.owasp.org/llm-top-10/
- OWASP Agentic Top 10 2026: https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/ · https://www.promptfoo.dev/docs/red-team/owasp-agentic-ai/
- NIST AI 600-1 summary: https://witness.ai/blog/nist-ai-600-1-generative-ai-profile/
- MITRE ATLAS agentic: https://labs.zenity.io/post/mitre-atlas-ai-agent-attack-techniques · https://www.vectra.ai/topics/mitre-atlas
- Design patterns paper: https://arxiv.org/html/2506.08837
- CaMeL: https://arxiv.org/pdf/2503.18813 · https://simonwillison.net/2025/Apr/11/camel/
- The Attacker Moves Second: https://arxiv.org/abs/2510.09023
- Agents Rule of Two: https://ai.meta.com/blog/practical-ai-agent-security/
- Spotlighting: https://arxiv.org/pdf/2403.14720
- Model Armor: https://docs.cloud.google.com/model-armor/overview · https://cloud.google.com/security-command-center/pricing · https://medium.com/google-cloud/google-cloud-model-armor-6242dbae90b8
- Prompt Guard 2: https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M
- Gemini safety settings: https://ai.google.dev/gemini-api/docs/safety-settings
- Sensitive Data Protection infoTypes: https://docs.cloud.google.com/sensitive-data-protection/docs/infotypes-reference
- promptfoo: https://www.promptfoo.dev/docs/red-team/configuration/ · https://www.promptfoo.dev/docs/red-team/strategies/ · https://www.promptfoo.dev/blog/promptfoo-joining-openai/
- AgentDojo: https://arxiv.org/pdf/2406.13352v1 · tau-bench: https://arxiv.org/abs/2406.12045
- Judge validation: https://hamel.dev/blog/posts/evals-faq/
- OTel GenAI: https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/ · https://github.com/open-telemetry/semantic-conventions-genai
- Langfuse: https://langfuse.com/integrations/frameworks/langchain · Phoenix: https://arize.com/docs/phoenix/integrations/typescript/langchain/langchain-js
- LangGraph JS: https://docs.langchain.com/oss/javascript/langgraph/interrupts · https://docs.langchain.com/oss/javascript/langchain/middleware/built-in
- AG-UI: https://docs.ag-ui.com/introduction · https://docs.ag-ui.com/concepts/events · https://docs.ag-ui.com/concepts/interrupts · https://github.com/ag-ui-protocol/ag-ui
- CopilotKit: https://docs.copilotkit.ai/reference/hooks/useInterrupt · https://docs.copilotkit.ai/guides/self-hosting · https://docs.copilotkit.ai/telemetry · https://www.copilotkit.ai/pricing
- CopilotKit + self-hosted LangGraph JS: https://forum.langchain.com/t/copilotkit-langgraph-agent-server-self-hosted-expected-integration-path-without-re-exposing-graphs/3876 · https://github.com/CopilotKit/CopilotKit/issues/1994
- Elysia: https://elysiajs.com/patterns/mount · https://elysiajs.com/essential/handler.html
