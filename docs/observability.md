# Observability and cost control

Feature [005](../specs/005-observability-and-cost/spec.md). Business code uses only the
OpenTelemetry **API**; the SDK is wired at the process edge in
[`src/telemetry/register.ts`](../src/telemetry/register.ts) and is **off unless an OTLP endpoint is
configured** (no-op API, zero overhead). See [ADR 0008](adr/0008-telemetry-api-only-and-pii.md).

![One booking message as a single trace in Jaeger](img/trace-booking.png)

*One patient message, captured from the local Jaeger while running the perf smoke (scripted
model, real orchestrator, real Postgres): `webhook.inbound` → `agent.turn` → model calls
(`chat …`), tools (`execute_tool …`) with their SQL (`pg.query:*`) → `outbox.dispatch`, linked
to the `confirm_booking` that committed the confirmation.*

## Run it locally
```bash
docker compose --profile observability up -d          # Postgres + Jaeger (UI http://localhost:16686)
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 PERF_CONVERSATIONS=1 PERF_WARMUP=0 PERF_REPETITIONS=1 pnpm perf:smoke
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 pnpm start   # the real service (needs its credentials)
```
`pnpm start` and `pnpm perf:smoke` load the bootstrap with `node --import`, so the `pg`
instrumentation is in place before `pg` is imported.

## Span catalogue
| Span | Where | Attributes |
|---|---|---|
| `webhook.inbound` (root, CONSUMER) | one per accepted patient message, started on acceptance (queue wait included) | `recepia.channel`, `recepia.message.ref` (keyed hash — a WhatsApp `wamid` encodes the phone), `recepia.patient.id` (keyed pseudonym), `recepia.patient.phone_masked` |
| `agent.turn` | `handleInbound` | `recepia.turn.status`, `recepia.conversation.status`, `recepia.prompt.version`, `recepia.conversation.cost_usd` |
| `chat {model}` (CLIENT) | every model call | GenAI semconv: `gen_ai.operation.name=chat`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens`, `gen_ai.response.finish_reasons`; plus `recepia.prompt.version`, `recepia.llm.cost_usd`, `recepia.llm.fallback` (+ `llm.fallback` event) |
| `execute_tool {name}` | every tool call | `gen_ai.tool.name`, `recepia.tool.outcome` (`ok` · `rejected` · `error`), `recepia.tool.rejected_by` (`unknown_tool` · `not_offered` · `foreign_hold` · `invalid_args` · `consent` · `after_handoff`), `error.type`, validated `recepia.tool.appointment_type` / `recepia.tool.slot_start` only |
| `outbox.dispatch` | every delivery attempt (in the turn or by the background job) | `recepia.outbox.kind`, `recepia.outbox.attempt`, `recepia.outbox.result`; **span link** to the span that enqueued the message (`outbox_message.trace_context`) |
| `job.retention` (root) | daily LGPD purge | counts only |
| `pg.*` | `@opentelemetry/instrumentation-pg` | statement text only — never parameter values; only inside a traced operation (`requireParentSpan`), so polling jobs and `/readyz` emit nothing |

## Logs
JSON lines (pino) on stdout: `level`, `time`, `msg`, `service`, `event`, and `trace_id` /
`span_id` inside a traced operation (webhook accept/handled/failed lines included) — filter a
conversation by `patient.id`, jump to its trace by `trace_id`. Errors are logged with their type,
masked message and masked stack. `LOG_LEVEL` sets the minimum level (`debug` adds one `turn.done`
line per turn); `.env` is loaded before the logger and the tracer read their settings.

## Personal data (LGPD, constitution V)
- Patients appear only as `patient.id` (HMAC-SHA256 of the phone with `TELEMETRY_HASH_KEY`, 16 hex)
  and `phoneMasked` (`***NNNN`). Without the key a random per-process key is used and a warning is
  logged — pseudonyms then change on restart.
- Message text, model output and patient names never reach logs or spans: content keys are dropped
  at any depth, tool arguments are reduced to validated non-personal fields, and model-chosen tool
  names are sanitised.
- Provider message ids are logged and traced only as a keyed reference (`messageRef`): a WhatsApp
  Cloud API `wamid` is base64 that encodes the sender's phone.
- Spans carry an error's **type** only, never its message (messages can echo provider bodies);
  messaging adapters mask and truncate provider error bodies; a redacting exporter masks phones in
  every exported string and drops exception messages/stacks set by third-party instrumentations.
- A backstop masks standalone 10–15 digit numbers and human-formatted phones (`+55 11 98765-4321`,
  `(11) 98765-4321`) in every logged string, without touching identifiers such as trace ids or UUIDs.
- Proven automatically: `tests/integration/pii-scan.test.ts` and `tests/integration/tracing.test.ts`
  scan every log line and exported span of real conversations — including a realistic `wamid` and a
  provider error that echoes the phone and the text; the `evals / fake` CI job fails on a full phone
  number in its debug logs. The `pg` instrumentation is not loaded in those tests; the redacting
  exporter covers it, and the captured Jaeger trace above was scanned for phones (none).

## Health
`GET /healthz` → 200 `{"status":"ok"}` (process alive). `GET /readyz` → 200 when `SELECT 1`
answers within 1 s, else 503. No auth, no configuration in the body, not logged per request.

## Cost
- **Prompt caching**: tools + the static instructions are one cached prefix (explicit breakpoint);
  automatic caching covers the growing conversation inside a turn. Measured live on
  `claude-sonnet-5-5`: the second call of a turn read 1,638 cached tokens and paid 2 uncached input
  tokens (input side ≈ 79 % cheaper). The dated line stays after the breakpoint.
- **Usage per conversation** (`conversation_state.state.usage`): tokens by kind, estimated cost,
  calls, models — priced from [`src/llm/pricing.json`](../src/llm/pricing.json) (dated; shared with
  the evaluation harness).
- **Budget** `AGENT_BUDGET_USD` (default US$ 0.25, ≈ 8× a full booking conversation): checked
  before every model call; reaching it hands the patient to reception (`escalated`, reason
  `budget_exceeded`, cost and budget in the audit payload) — unless the turn already committed a
  confirmation, which then ends the turn. The service refuses to start if a configured model has no
  price; a call answered by an unpriced model (a provider alias) is charged at the table's highest
  rate; when a later call of a turn fails, the spend of the calls that succeeded is still saved (the
  message stays unprocessed so a retry runs the turn).

## Fallback provider (optional)
Any OpenAI-compatible chat-completions endpoint (`FALLBACK_LLM_BASE_URL`, `FALLBACK_LLM_API_KEY`,
`FALLBACK_LLM_MODEL`; all three or none). Used only when the primary fails transiently (timeout,
connection, 408/429/5xx/529 — classified on the real SDK error classes) — never on refusals,
invalid requests or auth errors. The Anthropic call is bounded by `ANTHROPIC_TIMEOUT_MS` (default
30 s) and, when a fallback is configured, is **not retried** by the SDK, so a hung or failing call
fails over within one timeout. A secondary's refusal (`content_filter`) or cut-off (`length`) wins
over tool calls in the same response, so none of them runs. Measure a
candidate before relying on it: `pnpm evals:live --provider openai-compatible --repetitions 1`.

## Retention (LGPD, 90 days)
Daily (first run one minute after start): deletes conversation state idle for more than 90 days and
sent/failed/cancelled outbox messages older than 90 days; never pending messages, consent or audit;
one `retention_purged` audit row per run with counts. The audit log itself (which keeps escalation
context) and the consent ledger are retained by owner decision. By hand:
`pnpm retention:purge --dry-run` / `pnpm retention:purge [--days N]`.
