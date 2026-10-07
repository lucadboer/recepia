# Implementation Plan: Observability and Cost Control for the Booking Agent

**Branch**: `phase-3-observability` (feature `005-observability-and-cost`) | **Date**: 2026-10-07 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/005-observability-and-cost/spec.md`

## Summary
Make the agent operable and its spend bounded. **Tracing** with the OpenTelemetry API (no-op unless a collector is configured): one root span per inbound patient message, a turn span, one GenAI-semconv `chat` span per model call, one `execute_tool` span per tool call (outcome + the guardrail that rejected it), automatic `pg` spans, and `outbox.dispatch` spans linked to the turn that enqueued the message through a W3C `traceparent` stored on the outbox row. **Logs** become structured JSON (`pino`) with trace/span ids, a phone-masking backstop and a keyed patient pseudonym; every `console.*` on the service path is replaced; `GET /healthz` and `GET /readyz` join the webhook server. **Cost**: prompt caching (explicit breakpoint on the static system block, top-level automatic caching for the conversation tail), per-call usage accumulated in `ConversationState.usage` and priced from a single dated pricing table moved from `evals/` to `src/llm/`, and a per-conversation budget (default US$ 0.25) checked before every model call that hands off with `budget_exceeded`. **Resilience**: an `OpenAICompatibleLLM` adapter (plain `fetch`) and a `FallbackLLM` that switches only on transient errors; off unless configured. **LGPD**: a daily retention job (90 days) with a dry-run CLI. The evaluation harness reports cache hit ratio and provider, and prints the estimated cost of every live execution (the owner's credit is small).

## Technical Context
- **Language/Version**: TypeScript on Node 24 (engines ≥ 22.12), ESM, `tsx`.
- **Primary Dependencies (new)**: `@opentelemetry/api`, `@opentelemetry/sdk-trace-node` (brings `sdk-trace-base`, context manager, W3C propagator), `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/instrumentation`, `@opentelemetry/instrumentation-pg`, `@opentelemetry/resources`, `pino`. All added with `pnpm add` (latest that passes the minimum-release-age gate) and `pnpm audit`. No SDK for the fallback provider (plain `fetch`). Existing: `@anthropic-ai/sdk`, `pg`, Vitest 5, Biome.
- **Storage**: PostgreSQL — migration `010_outbox_trace_context.sql` (nullable `trace_context text`); `conversation_state.state` JSON gains `usage` (legacy rows default to zeros); new audit actions `budget_exceeded` (as an `escalated` reason, no new action) and `retention_purged`.
- **Testing**: Vitest. Tracing tests use an in-memory exporter registered by `tests/helpers/telemetry.ts`; logger tests capture a stream; fallback/OpenAI-compatible adapter tests use a local `node:http` stub server; retention and budget are integration tests against Postgres; one cheap live check (`LIVE_LLM=1`, single conversation) proves cache reads > 0.
- **Target Platform**: Node service (webhook + in-process jobs); local Jaeger via `docker compose --profile observability`; GitHub Actions (perf job gets a Jaeger service to measure overhead with a real exporter).
- **Project Type**: web service + CLI scripts.
- **Performance Goals**: telemetry adds < 10 % to the perf-smoke p95 (SC-507); disabled telemetry is a no-op.
- **Constraints**: zero PII in telemetry (SC-502); telemetry never fails or delays a turn; live model spend minimal (owner credit ≈ US$ 2.6 on 2026-10-07).
- **Scale/Scope**: one clinic, single process; no metrics pipeline or alerting in this slice.

## Constitution Check
| Principle | Status | Compliance |
|---|---|---|
| I Test-First | ✅ | Every new module (pseudonym, logger, tracing helpers, pricing/budget, OpenAI-compatible adapter, fallback, retention, health) is written test-first; integration tests prove the span tree and the PII scan over a real booking conversation; the no-overbooking gate is untouched. |
| II LLM Never Writes | ✅ | Telemetry only observes; the budget and fallback live in the orchestrator/adapters and never add a write path; the new `budget_exceeded` hand-off reuses `escalateToHuman`. |
| III Simplicity/YAGNI | ✅ (justified deps) | 7 new runtime deps, all for an explicit FR (FR-501..507). Pricing moves to `src/` because it now has two consumers (runtime budget + eval harness). `OpenAICompatibleLLM` + `FallbackLLM` make two real `LLMPort` providers. No metrics SDK, no logging transport, no provider SDK. |
| IV Escalate on Doubt | ✅ | Budget exhaustion, refusal and truncation hand off to reception with a deterministic pt-BR reply; fallback never retries a refusal. |
| V Traceability/LGPD | ✅ | No phone or message text in telemetry (masked + keyed pseudonym, pattern backstop, automated scan); `budget_exceeded` and `retention_purged` audited; retention job implements the owner's 90-day decision. |

Gate: **pass**.

## Project Structure

### Documentation (this feature)
```text
specs/005-observability-and-cost/
├── plan.md
├── research.md          # R1 tracing setup, R2 span model + attributes, R3 outbox link, R4 logs + PII, R5 caching, R6 usage/budget/pricing, R7 fallback, R8 health, R9 retention, R10 evals/perf, R11 live spend
├── data-model.md
├── quickstart.md
├── contracts/observability.md
└── tasks.md
```

### Source Code (repository root)
```text
src/
├── telemetry/
│   ├── register.ts        # loaded with `node --import`: NodeTracerProvider + OTLP exporter + pg instrumentation when an endpoint is set
│   ├── tracing.ts         # tracer, withSpan(), span name/attribute constants (GenAI semconv + recepia.*), outbox link helpers
│   ├── logger.ts          # pino facade: JSON, level, trace ids mixin, phone-masking formatter, configureLogger() for tests
│   └── pseudonym.ts       # maskPhone(), patientPseudonym() (HMAC-SHA256 with TELEMETRY_HASH_KEY or a per-process random key)
├── llm/
│   ├── pricing.json       # moved from evals/pricing.json (single source)
│   └── pricing.ts         # loadPricing, priceFor, costUsd, assertPriced
├── adapters/llm/
│   ├── anthropic-llm.ts   # + cache_control (system breakpoint + top-level automatic), timeout option, model/provider on results
│   ├── openai-compatible-llm.ts  # chat-completions over fetch, tools ↔ tool_calls, usage incl. cached tokens
│   ├── fallback-llm.ts    # primary → secondary on transient errors only
│   └── errors.ts          # isTransientLlmError (shared with evals classifyError)
├── agent/orchestrator.ts  # turn span, chat spans, usage accumulation, budget gate, tool spans via registry
├── agent/tool-registry.ts # ToolDispatchResult.rejectedBy (gate name) for the tool span
├── agent/system-prompt.ts # returns cacheablePrefixLength
├── db/migrations/010_outbox_trace_context.sql
├── db/repositories/outbox-repo.ts  # store/read trace_context
├── jobs/dispatch-outbox.ts         # outbox.dispatch span with link
├── jobs/retention.ts               # purgeInactive()
├── jobs/scheduler.ts               # + retention job (daily), logger
├── cli/retention-purge.ts          # `pnpm retention:purge [--dry-run]`
├── webhook/server.ts               # /healthz, /readyz, webhook.inbound root span, logger
└── composition.ts                  # FallbackLLM wiring, budget, pricing check at startup
docker-compose.yml                  # profile `observability`: Jaeger (OTLP 4318, UI 16686)
docs/observability.md, docs/img/trace-booking.png
```

**Structure Decision**: single project; telemetry is a cross-cutting `src/telemetry/` module used through the OTel API only (the SDK is wired in `register.ts`, never imported by business code), so tests and the eval harness run with the no-op API unless they register an in-memory provider.

## Complexity Tracking
| Item | Why needed | Simpler alternative rejected because |
|---|---|---|
| 7 runtime deps (OTel + pino) | FR-501..507 require standard export and structured logs | hand-rolled spans/JSON logs would not interoperate with any collector or log tooling and would be reinvented badly |
| `FallbackLLM` + second adapter | FR-513/514 | provider SDKs add deps for a protocol that is a single JSON POST |
