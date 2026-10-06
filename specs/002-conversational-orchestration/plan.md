# Implementation Plan: Conversational Orchestration

**Branch**: `main` (feature `002-conversational-orchestration`) | **Date**: 2026-06-19 | **Spec**: [spec.md](spec.md)

## Summary
Add a Claude tool-use orchestrator on top of feature 001's deterministic tools. The LLM proposes; the deterministic tools (unchanged) remain the only writers. "LLM never writes" is enforced **structurally** by three gates; "escalate on doubt" by a deterministic triage layer that runs before the LLM; LGPD opt-in by a consent gate before `confirm_booking`. Everything is built behind ports with fakes; real adapters are needs-creds scaffolds.

## Technical Context
- TS 6 / Node 20+, pnpm, Vitest, `pg`. No `@anthropic-ai/sdk` in the autonomous path (only a hand-written `LLMPort` + `FakeLLM`).
- New ports: `LLMPort` (fake + Anthropic scaffold), `ConversationStorePort` (fake + DB scaffold). Consent is a repo (YAGNI — no second consumer).
- Reuses 001: all `src/tools/*`, `Deps`, `domain/*`, `config`, `tests/helpers/db.ts`, fakes.
- Only additive edit to a 001 file: extend `AuditAction` union (`consent_recorded`, `consent_revoked`).

## Constitution Check
| Principle | Status | Compliance |
|---|---|---|
| I Test-First | ✅ | RED→GREEN; behavioral tests over tool side-effects, never LLM text. |
| II LLM Never Writes | ✅ structural | 3 gates (closed allowlist; slots only from `get_availability`; confirm needs in-conversation hold) + hostile-FakeLLM tests. |
| III Simplicity/YAGNI | ✅ | New ports justified (2 consumers each); consent is repo; inbound = pure parsers. |
| IV Escalate on Doubt | ✅ | Deterministic triage before LLM; max-iterations + tool-error escalate. |
| V Traceability/LGPD | ✅ | Consent ledger + audit; gate blocks confirm; retention deferred. |

## Project Structure (new)
See [/plan-mode plan] — modules under `src/agent/`, `src/ports/`, `src/adapters/{fakes,llm,messaging,calendar}/`, migrations `005_patient_consent.sql` + `006_conversation_state.sql`, repos `consent-repo.ts` + `conversation-repo.ts`.

## Migration numbering (pre-flight correction)
The runner (`src/db/migrate.ts`) applies any `*.sql` not yet in `schema_migrations`, in lexical order. To keep lexical order == application order: **`005_patient_consent` (created in Phase 4)**, **`006_conversation_state` (created in Phase 8)**. `resetDb` gains `patient_consent` (Phase 4) and `conversation_state` (Phase 8) in its TRUNCATE list; neither needs trigger-disable (only `audit_log` is append-only).

## Phases
Phase 0 spec (this) → 1 LLMPort+FakeLLM+state → 2 triage+intent → 3 tool-registry+guardrails → 4 consent → 5 orchestrator → 6 inbound parsers → 7 adapter scaffolds → 8 conversation DB scaffold. Each: RED→GREEN, green suite, conventional commit.

## Hardening addendum (Phase 11, 2026-10-05)

Technical decisions behind tasks T236–T246. Product-facing behaviour is in [spec.md](spec.md) (FR-204 amended, FR-211–FR-214).

- **Transactional outbox** (`outbox_message`, migration 008). `confirm_booking` and `escalate_to_human` write their patient/reception message as an outbox row **in the same transaction** as the booking flip / audit row. `dispatchOutbox` (`src/jobs/dispatch-outbox.ts`) claims one due row per transaction with `FOR UPDATE SKIP LOCKED`, sends through `MessagingPort` with a timeout, then marks `sent` or schedules a retry (backoff 5s, 30s, 2m, 10m, 30m). On the 6th failure the row becomes `failed`, an `outbox_dead_letter` audit row is written and an escalation row is enqueued for reception (a dead-lettered escalation only audits). Delivery is **at-least-once**: a crash between send and commit re-sends once. `dedupe_key` dedupes enqueue, not delivery. The orchestrator nudges the dispatcher right after saving state so the happy path stays synchronous in practice; `server.ts` also polls every 15 s. The orchestrator's own final LLM reply stays a direct send (no committed sibling write to be atomic with); revisit with the durable inbound queue (feature 006).
- **Constitution V interpretation**: outbox rows are delivery plumbing, not domain writes. The audited domain write stays `booking_confirmed` / `escalated`, whose payload now carries the `outboxId`. New audit actions: `outbox_dead_letter`, `conversation_released`.
- **Optimistic concurrency** (`conversation_state.version`, migration 007). `save` is a compare-and-swap (`WHERE version = $expected`); zero rows → `ConversationConflictError`. The webhook serializes `onInbound` per phone in-process (`PerKeyQueue`), so a conflict can only happen across processes or against the release CLI. On conflict the turn fails loudly and is logged; no retry (the LLM would re-run and risk duplicate side-effects; tool writes already committed are idempotent) and no patient message. Feature 006 replaces the in-process queue with a durable Postgres queue.
- **Handed-off state**. `status = escalated` is read on entry; the orchestrator short-circuits before triage and the LLM, after the opt-out fast path. `escalatedAt` / `handoffNoticeAt` are ISO strings in the JSONB state. Release = `releaseConversation(pool, phone, now)` (reset + `conversation_released` audit, actor `human`) exposed as `pnpm conversation:release <phone>`; `HANDOFF_AUTO_RELEASE_HOURS` (unset = never) is a safety valve. A release command sent by reception over WhatsApp is deferred to T223.
- **Timezone**. `domain/time.ts` and `messages.ts` use `Intl.DateTimeFormat` with `CLINIC_TIMEZONE` (cached formatter per zone, two-pass local→UTC inversion for DST edges). `CLINIC_UTC_OFFSET_MINUTES` is removed. `buildSystemPrompt({ now, timezone })` appends a dated line **last** (static block first, so a prompt-cache breakpoint can later sit after the static part).
- **State bounds** (`config.ts`): `HISTORY_MAX_MESSAGES = 40` (trim at the first user text message past the cut so tool_use/tool_result pairs stay together), `AVAILABILITY_MAX_SLOTS = 40` (the registry exposes at most the 40 earliest free slots per `get_availability` call and flags `truncated` so the model narrows the range), `OFFERED_SLOTS_MAX = 3 × 40` plus pruning of slots already in the past (so what the model just saw is always still "offered"), `ACTIVE_HOLDS_MAX = 10`, `PROCESSED_IDS_MAX = 200`. `boundState(state, now)` runs after load and before every save.
- **Escalation payload**. `escalateToHuman(deps, { reason, phone, context, summary? })`; `summary` is `summarizeHistory(history)` — the last 6 patient/assistant text lines, each truncated to 160 chars, never an LLM call. Reception message is multi-line pt-BR.
- **Schedulers and shutdown**. `server.ts` runs `dispatchOutbox` (15 s) and `expireHolds` (60 s) on `setInterval` with an in-flight guard; `createShutdown` stops the HTTP server, clears timers, drains the per-phone queue (15 s budget) and closes the pool on SIGTERM/SIGINT. `expireHolds` audits the ids returned by `UPDATE … RETURNING` (closes T234).
- **Webhook**. Exact `pathname` routing via `new URL(url, "http://localhost")`; Evolution requires `basePath + "/" + <token>` with exactly one segment; 256 KiB body cap → 413; `requestTimeout = 10 s`, `headersTimeout = 5 s`. Edge dedupe (`RecentIds`) records an id only after `onInbound` resolves, making redelivery after a failed turn re-processable (explicit at-least-once; DB idempotency by `providerMessageId` remains the guarantee).
- **Migration numbering**: `007_conversation_version.sql`, `008_outbox_message.sql`. `resetDb` truncates `outbox_message` too.
- **Delivery duplicates**: the dispatcher's send timeout (15 s) can mark a row for retry after the provider actually delivered it, so a recipient may receive the same message twice (at-least-once). Accepted for Phase 0; idempotent sends keyed by provider message id come with feature 006.
- **In-turn flush scope**: the orchestrator flushes only rows addressed to the current patient and to reception (`recipients` filter in `dispatchOutbox`), so a slow provider never makes one patient wait on other conversations' retries; everything else belongs to the 15 s poller.
- **Booking-window guard in the tool**: `holdSlot` rejects a start outside `[now + MIN_LEAD, now + HORIZON]` or off the 30-min grid with `SlotOutOfWindowError` (mapped to a pt-BR recovery reply). Gate 2 (offered slots) is still the conversational guard; the tool is the deterministic backstop.
- **Hand-off is terminal within a response**: once a tool returns `escalated`, the remaining `tool_use` blocks of the same LLM response are answered with a cancellation `tool_result` and never executed (a `confirm_booking` after `escalate_to_human` would flip the status back to `completed`). Tools that escalate internally and then throw (`confirm_booking` on persistent calendar failure / orphan compensation) flag the error (`flagEscalated`); the registry turns a flagged error into `escalated: true`, so the orchestrator hands off without notifying reception twice.
- **Opt-out cancels queued patient messages**: `recordOptOut` cancels every pending outbox row addressed to the patient in the same transaction (status `cancelled`, audit `outbox_cancelled` with the ids). "Não vou mais te enviar mensagens" therefore holds even for a confirmation stuck in retry. Whether the agent should also stop answering after opt-out is a product decision (T247, NEEDS-USER).
- **Outbox rows know their conversation**: `conversation_phone` (migration 009) is the patient a message is about even when the recipient is reception; the in-turn flush filters on it, so other patients' escalations (same reception phone) never delay a turn.
- **Flush only after the CAS**: on every path the outbox is flushed after `persist` succeeded, so a turn that lost the compare-and-swap delivers nothing (its committed rows wait for the poller).
- **Offered-slot recency**: `recordOfferedSlots` moves re-offered slots to the tail, so the cap always keeps what the model most recently showed.
- **Confirmation ownership** (`confirm_booking` outcome): `confirmed` means the outbox owns the patient message — this call enqueued it, or it is still pending, or this call's COMMIT landed but the acknowledgment was lost (the row exists). `already_confirmed` means the earlier confirmation already left. The orchestrator suppresses its closing text only for `confirmed` (T227), so a lost COMMIT ack never produces two messages.
- **Shutdown order**: stop jobs → close the listener and wait for in-flight requests (a body still uploading may enqueue a turn) → drain the per-phone queue → close deps, all within one `SHUTDOWN_TIMEOUT_MS` budget; `pool.end()` is bounded by the remaining budget too (a stalled client can no longer hold the process), and the entrypoint exits 1 when anything did not finish.
- **Webhook parsing**: a request target WHATWG URL rejects (e.g. `//`) is answered 400 instead of throwing inside the handler.
- **Process model**: `pnpm start` runs `node --import tsx src/server.ts` (no `tsx` relay process): the `tsx` binary forwards SIGTERM to its child and exits first (code 143), which cut the graceful shutdown short in the smoke test; running Node directly lets `createShutdown` finish and exit 0.
- **Dependencies**: none added.
