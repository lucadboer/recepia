# Contract: Observability and Cost Control

Format: API + Guarantees + Required Tests (tests first, constitution I).

## `withSpan(name, attributes, fn)` / tracer (`src/telemetry/tracing.ts`)
- **Guarantees**: runs `fn` inside an active span; records exceptions with `error.type` and status ERROR and rethrows; never throws because of telemetry; with no provider registered it is a no-op.
- **Tests**: in-memory exporter — span created with attributes, error recorded and rethrown, nesting follows the active context.

## Turn tracing (`handleInbound`, webhook)
- **Guarantees**: one `webhook.inbound` root per message with `agent.turn` child; one `chat` span per model call with the GenAI attributes and prompt version; one `execute_tool` span per tool call with `recepia.tool.outcome` and `recepia.tool.rejected_by`; triage escalations produce no `chat` span; no attribute value contains a full phone or message text.
- **Tests**: booking conversation through `createWebhookServer` with an in-memory exporter → span tree per message; hostile script → `rejected_by` values; PII scan over all attributes and events.

## Outbox link
- **Guarantees**: `enqueueOutbox` stores the active `traceparent`; `dispatchOutbox` creates `outbox.dispatch` per row linked to it (including retries and dead-letter); NULL context → no link, no error.
- **Tests**: enqueue inside a span → row has a valid traceparent; dispatch → span with a link to that trace; job dispatch outside a turn still links.

## Logger (`src/telemetry/logger.ts`, `src/telemetry/pseudonym.ts`)
- **Guarantees**: JSON lines with `level`, `time`, `msg`; `trace_id`/`span_id` inside a span; phone patterns masked in every string value; `text/body/content/patient_name` keys removed; `patientPseudonym` stable for the same key, different across keys, never contains the phone; `maskPhone` keeps the last 4 digits.
- **Tests**: captured stream; error containing a phone is masked; pseudonym properties; random-key warning once.

## Health (`createWebhookServer`)
- **Guarantees**: `GET /healthz` 200 always; `GET /readyz` 200 when the probe resolves true within 1 s, else 503; other methods 405/404; no body content beyond status.
- **Tests**: probe true/false/throws/hangs; unrelated paths unchanged.

## Usage, pricing, budget
- **Guarantees**: `src/llm/pricing.ts` is the single table (evals re-export); `assertPriced(models)` throws for an unpriced model; usage accumulates per call into `state.usage`; at `costUsd >= budgetUsd` before a call → no call, escalation `budget_exceeded` with cost/budget in the audit payload, hand-off reply unless a committed confirmation owns the reply; reset with the conversation.
- **Tests**: scripted usage crosses the budget at call N → call N+1 never happens; confirmation-owned reply case; legacy state; startup check.

## Prompt caching (`AnthropicLLM`)
- **Guarantees**: `system` sent as `[static + cache_control, dated]` when `systemCacheablePrefix` is given; top-level `cache_control: {type:"ephemeral"}`; tools unchanged; cache usage mapped.
- **Tests**: stubbed client asserts the request shape; live check (one conversation) shows cache reads > 0.

## `OpenAICompatibleLLM` / `FallbackLLM`
- **Guarantees**: mapping in research R7; transient errors (timeout, 408/429/5xx, connection) → secondary; refusal/4xx/auth → never; both fail → the primary's error is rethrown with the secondary's as cause; served provider/model on the result.
- **Tests**: local HTTP stub — request body shape, tool_calls round trip, finish reasons, usage with cached tokens, error statuses, timeout; fallback matrix.

## Retention (`purgeInactive`, `pnpm retention:purge`)
- **Guarantees**: per research R9; one transaction; dry run writes nothing; pending outbox, consent and audit untouched.
- **Tests**: seeded old/new rows → exact deletions and one audit row; dry run counts only; scheduler includes the job.
