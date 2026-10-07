# Contract: Conversational Orchestration

Format: API + Guarantees + Required Tests (tests written BEFORE impl, behavioral — assert tool/DB/fake side-effects, never LLM text).

## `LLMPort.turn(input) -> LlmTurnResult`
- **Guarantees**: provider-neutral single tool-use turn; returns `tool_use` block(s) or final text. No writes. `FakeLLM` replays scripted turns and records `receivedInputs`.
- **Tests**: FakeLLM static + reactive scripts return turns in order / branch on last `tool_result`.

## `handleInbound(deps: AgentDeps, msg: InboundMessage) -> LoopResult`
- **Guarantees**:
  - Idempotent per `providerMessageId` (FR-207).
  - Runs deterministic triage BEFORE the LLM; on signal → `escalateToHuman` + pt-BR hand-off, no LLM call, no booking (FR-204).
  - LLM acts only via the closed tool allowlist (FR-201); slots only from `get_availability` (FR-202); `confirm_booking` only for an in-conversation hold (FR-203).
  - Consent gate before `confirm_booking` (FR-205); confirm impossible without recorded opt-in.
  - Bounded by `MAX_ITERATIONS` → escalate + pt-BR fallback (FR-206).
  - Tool errors → pt-BR recovery, surfaced to the loop (FR-209).
  - *(Phase 11)* Handed-off: when the loaded state is `escalated`, returns `{ status: "handed_off" }` without calling the LLM or re-notifying reception; sends at most one notice per `HANDOFF_NOTICE_INTERVAL_MS`; opt-out still processed first (FR-211). `completed` state resets to a fresh conversation keeping `processedInboundIds` (FR-212).
  - *(Phase 11)* An `escalated` tool result ends the loop: the deterministic hand-off reply is sent, the LLM is not called again.
  - *(Phase 11)* State is bounded (`boundState`) after load and before save; `save` throws `ConversationConflictError` on a stale `version` and the turn fails loudly with no patient message.
  - *(Phase 11)* After saving, nudges `dispatchOutbox` so committed confirmations/escalations go out before the orchestrator's own reply; dispatcher errors never fail the turn.
  - *(Phase 11)* The system prompt is built per turn with `{ now, timezone }` (dated line last).
- **Tests** (behavioral, FakeLLM-scripted): happy book (1 event, 1 pt-BR msg, audit rows); hostile tool name → 0 writes; confirm w/ foreign holdId → 0 events; hold of non-offered slot → 0 bookings; triage escalation → LLM not called; consent gate blocks confirm until opt-in; max-iterations bound; tool-error recovery; duplicate inbound no-op; *(Phase 11)* handed-off short-circuit (LLM not called, reception count unchanged, one notice then silence, notice again after the interval, opt-out while handed off, release → LLM called again, auto-release); completed → fresh conversation with dedupe kept; two concurrent turns for one phone → one `ConversationConflictError`, no lost update; escalate tool stops the loop; reception message carries phone + summary.

## `releaseConversation(pool, phone, now) -> boolean` *(Phase 11)*
- **Guarantees**: only an `escalated` conversation is released; resets to a fresh state keeping `processedInboundIds`; writes `conversation_released` (actor `human`) in the same transaction as the state save; returns `false` when nothing to release. Exposed as `pnpm conversation:release <phone>`.
- **Tests**: release then next inbound calls the LLM; audit row present; releasing an active conversation is a no-op.

## `dispatchOutbox(deps, { batchSize }) -> { sent, retried, failed }` *(Phase 11)*
- **Guarantees**: claims one due `pending` row per transaction with `FOR UPDATE SKIP LOCKED`; sends via `MessagingPort` with a timeout; marks `sent` (with `sent_at`) or schedules the next attempt with backoff; on the 6th failure marks `failed`, writes `outbox_dead_letter`, and enqueues an escalation to reception (a dead-lettered escalation only audits). At-least-once; concurrent dispatchers never deliver the same row twice while both are alive.
- **Tests**: enqueue → dispatch → sent; dedupe key → single row; failing messaging → attempts/next_attempt_at advance; retry after clock advance; dead-letter path (audit + escalation row); two concurrent dispatchers over N rows deliver each exactly once.

## `PerKeyQueue` *(Phase 11)*
- **Guarantees**: `run(key, fn)` serializes calls per key, overlaps across keys, a rejection never blocks the next call, `inFlight` returns to 0, `drain(timeoutMs)` resolves when idle or times out.
- **Tests**: same-key ordering; cross-key overlap; rejection isolation; drain.

## `tool-registry` (the structural gates)
- **Guarantees**: closed map name→{schema,validate,handler}; `type` arg is enum of `ROUTINE_TYPES`; ISO→Date parse+validate; results show the model clinic-local times with offset + a pt-BR label (FR-213, amended 2026-10-07); rejects unknown tools; enforces offered-slots + in-conversation-hold gates; wraps unchanged 001 tools.
- **Tests**: non-offered slot rejected (0 booking); foreign holdId rejected (0 event); unknown tool rejected.

## consent (`hasConsent` / `recordConsent` / `recordOptOut`)
- **Guarantees**: latest-row-wins ledger; opt-out reversible; every change audited; gate predicate used by orchestrator before confirm.
- **Tests**: unknown phone → false; record → true + `consent_recorded` audit; opt-out → false + `consent_revoked` audit.

## inbound parsers (`parseEvolutionInbound` / `parseCloudApiInbound`)
- **Guarantees**: pure; text message → `InboundMessage`; status/receipt/group/non-text → ignored; Cloud API batch → multiple.
- **Tests**: fixtures (no secrets).

## adapter scaffolds (Anthropic / Evolution / Cloud API / Google Calendar)
- **Guarantees**: satisfy their port; throw `NotConfigured` without creds; network isolated behind a marked boundary (never exercised without creds).
- **Tests**: env unset → `NotConfigured`; typecheck proves port conformance.
