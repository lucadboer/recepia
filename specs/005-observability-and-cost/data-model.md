# Data Model: Observability and Cost Control

## Database
| Change | Detail |
|---|---|
| `outbox_message.trace_context text NULL` (migration `010_outbox_trace_context.sql`) | W3C `traceparent` of the turn that enqueued the row; NULL when tracing is off or for rows written before 010. |
| `audit_log` action `retention_purged` | actor `system`; payload `{ conversationStates, outboxMessages, olderThanDays, cutoff }` — counts only. |
| `audit_log` action `escalated` with reason `budget_exceeded` | payload adds `{ costUsd, budgetUsd }` (+ `promptVersion` like every model-initiated escalation). |

## Conversation state (JSON in `conversation_state.state`)
`usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, calls, models: string[] }` — zeros/empty in a fresh conversation, reset by `resetConversation`, legacy rows read as zeros.

## Ports
- `LlmTurnInput.systemCacheablePrefix?: number` — length of the static part of `system` (cache breakpoint).
- `LlmTurnResult.model?: string` (served model), `LlmTurnResult.provider?: "anthropic" | "openai-compatible" | string`.
- `ToolDispatchResult.rejectedBy?: "unknown_tool" | "not_offered" | "foreign_hold" | "invalid_args"`; the orchestrator adds `consent` and `after_handoff`.
- `AgentDeps.budgetUsd?: number`, `AgentDeps.pricing?: PricingTable`.

## Telemetry entities (not persisted)
- **Span** names: `webhook.inbound`, `agent.turn`, `chat {model}`, `execute_tool {name}`, `outbox.dispatch`, `job.{name}`, `pg.*` (instrumentation).
- **Patient pseudonym**: `{ id: hex16, phoneMasked: "***NNNN" }`; **message reference**: `messageRef(providerMessageId)` = keyed hex16 (review 2026-10-07: a WhatsApp `wamid` encodes the phone, so raw ids never reach telemetry).
- **Log record**: `{ level, time, msg, service, trace_id?, span_id?, event?, patient?: { id, phoneMasked }, messageId?, … }` — never `text`, `body`, `content`, `patient_name`.

## Files
| Path | Content |
|---|---|
| `src/llm/pricing.json` | dated pricing table (moved from `evals/pricing.json`) |
| `docs/observability.md` | how to run the collector, span catalogue, log fields, budget, fallback, retention |
| `docs/img/trace-booking.png` | captured trace of one booking message |
