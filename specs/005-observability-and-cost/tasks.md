---
description: "Task list for 005-observability-and-cost"
---

# Tasks: Observability and Cost Control for the Booking Agent

**Input**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/observability.md](contracts/observability.md), [quickstart.md](quickstart.md)

**Tests**: REQUIRED (constitution I) — every module test-first (RED → GREEN). Telemetry tests use an in-memory exporter; no live call except T530 (one conversation, ≤ US$ 0.02 — owner credit is small).

**Organization**: US1 traces, US2 logs + health, US3 usage/budget/caching, US4 fallback provider, US5 retention. Ids continue the convention: **T5xx**.

## Format: `[ID] [P?] [Story] Description with file path`

---

## Phase 1: Setup

- [ ] T501 Add runtime deps with `pnpm add` (latest passing the release-age gate): `@opentelemetry/api`, `@opentelemetry/sdk-trace-node`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/instrumentation`, `@opentelemetry/instrumentation-pg`, `@opentelemetry/resources`, `pino`; `pnpm audit` with no HIGH/CRITICAL; note any `minimumReleaseAgeExclude` needed in `pnpm-workspace.yaml`
- [ ] T502 [P] `docker-compose.yml` profile `observability` (Jaeger, OTLP 4318, UI 16686); `.env.example` gains `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `LOG_LEVEL`, `TELEMETRY_HASH_KEY`, `AGENT_BUDGET_USD`, `ANTHROPIC_TIMEOUT_MS`, `FALLBACK_LLM_BASE_URL/API_KEY/MODEL/TIMEOUT_MS`; `tests/setup.ts` sets `LOG_LEVEL=silent` unless provided

---

## Phase 2: Foundational

- [ ] T503 [P] Unit test `tests/unit/pseudonym.test.ts`: `maskPhone` keeps the last 4 digits (short/odd inputs), `patientPseudonym` stable per key, differs across keys, never contains the phone or its digits run, random key when `TELEMETRY_HASH_KEY` is absent (warns once) — must FAIL
- [ ] T504 [P] Implement `src/telemetry/pseudonym.ts` — make T503 pass
- [ ] T505 [P] Unit test `tests/unit/logger.test.ts`: JSON lines with level/time/msg; `trace_id`/`span_id` inside an active span only; phone patterns masked in nested strings and error messages; `text/body/content/patient_name` removed; `child` bindings; `configureLogger` level — must FAIL
- [ ] T506 Implement `src/telemetry/logger.ts` (pino facade + `configureLogger`) — make T505 pass
- [ ] T507 [P] Unit test `tests/unit/tracing.test.ts` + helper `tests/helpers/telemetry.ts` (in-memory exporter, async-hooks context, W3C propagator): `withSpan` records attributes, nests, records exceptions (`error.type`, status ERROR) and rethrows; no-op when nothing is registered; `injectTraceparent`/`linkFromTraceparent` round trip, invalid input → no link — must FAIL
- [ ] T508 Implement `src/telemetry/tracing.ts` (tracer, `withSpan`, attribute constants, traceparent helpers) and `src/telemetry/register.ts` (provider + OTLP exporter + pg instrumentation when an endpoint is set; `shutdownTelemetry()`) — make T507 pass
- [ ] T509 [P] Unit test `tests/unit/pricing.test.ts` (moved from `evals-pricing`): table at `src/llm/pricing.json`, `assertPriced` throws for an unpriced model and lists it; evals re-export still works — must FAIL
- [ ] T510 Move the table to `src/llm/pricing.{json,ts}`, re-export from `evals/lib/pricing.ts`, update README/CONTRIBUTING links — make T509 pass

**Checkpoint**: pseudonym, logger, tracing helpers and pricing ready; nothing wired yet.

---

## Phase 3: User Story 1 — Follow one message end to end (P1) 🎯 MVP

**Independent Test**: a booking conversation through the webhook with an in-memory exporter yields one trace per message with the expected tree and no PII.

- [ ] T511 [P] [US1] Integration test `tests/integration/tracing.test.ts`: booking via `createWebhookServer` → per message one `webhook.inbound` root → `agent.turn` → `chat …` (GenAI attrs, prompt version) / `execute_tool …` (outcome) and `outbox.dispatch` linked; triage message has no `chat` span; hostile script records `rejected_by` = `not_offered`, `foreign_hold`, `unknown_tool`, `consent`; PII scan of every attribute/event finds no fixture phone and no message text — must FAIL
- [ ] T512 [P] [US1] Unit/integration test additions in `tests/integration/tool-registry.test.ts`: `rejectedBy` per gate and `invalid_args` — must FAIL
- [ ] T513 [P] [US1] Integration test in `tests/integration/outbox.test.ts`: enqueue inside a span stores a valid traceparent; outside → NULL; dispatch creates `outbox.dispatch` linked to it (also on retry/dead-letter) — must FAIL
- [ ] T514 [US1] `src/agent/tool-registry.ts`: `ToolDispatchResult.rejectedBy` — make T512 pass
- [ ] T515 [US1] Migration `src/db/migrations/010_outbox_trace_context.sql`; `enqueueOutbox` stores the traceparent, `claimDue` returns it; `src/jobs/dispatch-outbox.ts` spans with links — make T513 pass
- [ ] T516 [US1] `src/agent/orchestrator.ts`: `agent.turn` span, `chat` span per model call (usage, finish reason, provider, model, prompt version, cost), `execute_tool` span per tool (consent / after-handoff rejections included)
- [ ] T517 [US1] `src/webhook/server.ts`: `webhook.inbound` root span per accepted message (both channels) wrapping the queued turn; `src/jobs/scheduler.ts`: `job.<name>` root spans — make T511 pass
- [ ] T518 [US1] `package.json` `start` and `perf:smoke` load `--import ./src/telemetry/register.ts`; graceful shutdown flushes telemetry (`src/server.ts`, `src/webhook/shutdown.ts`)

**Checkpoint**: traces complete and PII-free.

---

## Phase 4: User Story 2 — Safe, correlated logs + health (P1)

- [ ] T519 [P] [US2] Integration test `tests/integration/health.test.ts`: `/healthz` 200; `/readyz` 200 / 503 on false, throw and > 1 s; POST → 405; unrelated paths unchanged — must FAIL
- [ ] T520 [US2] `src/webhook/server.ts` health routes + `ready` option; `src/server.ts` wires `SELECT 1` — make T519 pass
- [ ] T521 [US2] Replace `console.*` on the service path (`server.ts`, `webhook/server.ts`, `webhook/shutdown.ts`, `agent/orchestrator.ts`, `jobs/scheduler.ts`) with `log` + pseudonym fields; test in `tests/unit/logger.test.ts` that the webhook inbound/handled lines carry pseudonym + masked phone and never the phone
- [ ] T522 [US2] SC-502 automated scan: `tests/integration/pii-scan.test.ts` runs a booking + an escalation with debug logs captured and an in-memory exporter, and asserts no fixture phone/message text in any line or attribute; `evals.yml` fake job runs `LOG_LEVEL=debug pnpm evals:fake` and fails on a full `+55…` phone in the output

---

## Phase 5: User Story 3 — Bounded cost + caching (P1)

- [ ] T523 [P] [US3] Unit test (`tests/unit/anthropic-llm.test.ts`): system sent as two blocks with `cache_control` on the static one when `systemCacheablePrefix` is set; top-level `cache_control: {type:"ephemeral"}`; plain string otherwise; `timeout` from options/env; result carries `model` and `provider` — must FAIL
- [ ] T524 [P] [US3] Unit test (`tests/unit/prompt-loader.test.ts`): `cacheablePrefixLength` = length of the static block; `text.slice(0, n)` identical across instants — must FAIL
- [ ] T525 [P] [US3] Integration test `tests/integration/orchestrator-budget.test.ts`: scripted usage crosses `budgetUsd` at call N → call N+1 never made, `escalated` audit reason `budget_exceeded` with cost/budget, hand-off reply, status escalated; a confirmation committed before the cut owns the reply; usage accumulates in state and resets on a fresh conversation; legacy state without `usage` loads as zeros; the system cacheable prefix is passed to the LLM — must FAIL
- [ ] T526 [US3] Implement caching in `src/adapters/llm/anthropic-llm.ts` and `cacheablePrefixLength` in `src/agent/system-prompt.ts`; `LlmTurnInput.systemCacheablePrefix`, `LlmTurnResult.model/provider` in `src/ports/llm-port.ts` — make T523/T524 pass
- [ ] T527 [US3] Implement usage accumulation + budget gate (`src/agent/orchestrator.ts`, `src/agent/conversation.ts`, `src/agent/types.ts`, `src/db/repositories/conversation-repo.ts`, `src/config.ts` `DEFAULT_AGENT_BUDGET_USD`) — make T525 pass
- [ ] T528 [US3] `src/composition.ts`: `AGENT_BUDGET_USD` parsing (invalid → fail fast), `assertPriced` for the primary (and fallback) model at startup, `ANTHROPIC_TIMEOUT_MS`; unit test in `tests/unit/composition-env.test.ts`
- [ ] T529 [US3] Evals: `cost.cacheHitRatio` in `evals/lib/metrics.ts`, report + README block row, live rows print per-execution estimated cost and running total (`evals/run.ts`); tests in `tests/unit/evals-metrics.test.ts`, `evals-report.test.ts`, `evals-readme-block.test.ts`
- [ ] T530 [US3] Live caching check (≤ US$ 0.02): one round trip with `LIVE_LLM=1` shows `cacheReadTokens > 0` on the second call; record the numbers in `research.md` R5

---

## Phase 6: User Story 4 — Fallback provider (P2)

- [ ] T531 [P] [US4] Unit test `tests/unit/openai-compatible-llm.test.ts` against a local `node:http` stub: request body (model, messages mapping incl. tool_calls/tool role, tools, no thinking), auth header, finish reasons → stopReason, unparsable arguments → `{}`, usage with cached tokens, 429/5xx → transient `LlmProviderError`, 400/401 → non-transient, timeout → transient, `NotConfigured` without config — must FAIL
- [ ] T532 [US4] Implement `src/adapters/llm/openai-compatible-llm.ts` and `src/adapters/llm/errors.ts` (`LlmProviderError`, `isTransientLlmError`) — make T531 pass
- [ ] T533 [P] [US4] Unit test `tests/unit/fallback-llm.test.ts`: transient matrix → secondary used and result tagged; refusal / 400 / 401 → secondary never called; both fail → primary error rethrown with cause; span event recorded — must FAIL
- [ ] T534 [US4] Implement `src/adapters/llm/fallback-llm.ts`; wire in `src/composition.ts` when `FALLBACK_LLM_*` are set; `evals/lib/runner.ts` `classifyError` reuses `isTransientLlmError` — make T533 pass
- [ ] T535 [US4] Evals `--provider anthropic|openai-compatible` in `evals/run.ts`; report `provider` field; tests in `tests/unit/evals-live.test.ts`

---

## Phase 7: User Story 5 — Retention (P2)

- [ ] T536 [P] [US5] Integration test `tests/integration/retention.test.ts`: old/new conversation states and outbox rows of every status → exact deletions, pending/consent/audit untouched, one `retention_purged` row with counts; dry run deletes nothing; `--days` override; scheduler lists `retention` — must FAIL
- [ ] T537 [US5] Implement `src/jobs/retention.ts`, `src/cli/retention-purge.ts` (`pnpm retention:purge`), audit action in `src/db/repositories/audit-repo.ts`, daily job in `src/jobs/scheduler.ts` (`RETENTION_INTERVAL_MS`) — make T536 pass

---

## Phase 8: Polish

- [ ] T538 `.github/workflows/perf.yml`: Jaeger service + OTLP endpoint so the p95 budget is measured with a real exporter (SC-507)
- [ ] T539 [P] `docs/observability.md` (collector, span catalogue, log fields, pseudonym, budget, fallback, retention) and `docs/img/trace-booking.png` captured from Jaeger; README "Observability" section + guarantee rows; CONTRIBUTING env/commands
- [ ] T540 [P] ADR `docs/adr/0008-telemetry-api-only-and-pii.md` (OTel API in business code, SDK at the edge, pseudonym + masking, no content in telemetry)
- [ ] T541 Coverage: new modules inside thresholds (`register.ts` excluded like other process entrypoints, with a comment)
- [ ] T542 Self-review + Codex review; fix findings; update checkboxes

## Dependencies
Setup → Foundational → US1 (needs tracing + logger) → US2 (logger wiring builds on US1 spans) ; US3 depends only on Foundational (pricing) ; US4 depends on US3's port fields (`model/provider`) ; US5 independent after Foundational. Polish last.

## Parallel opportunities
T503/T505/T507/T509 tests in parallel; T511/T512/T513; T523/T524/T525; T531/T533; US5 can run alongside US3/US4.
