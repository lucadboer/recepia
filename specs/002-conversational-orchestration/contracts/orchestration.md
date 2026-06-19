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
- **Tests** (behavioral, FakeLLM-scripted): happy book (1 event, 1 pt-BR msg, audit rows); hostile tool name → 0 writes; confirm w/ foreign holdId → 0 events; hold of non-offered slot → 0 bookings; triage escalation → LLM not called; consent gate blocks confirm until opt-in; max-iterations bound; tool-error recovery; duplicate inbound no-op.

## `tool-registry` (the structural gates)
- **Guarantees**: closed map name→{schema,validate,handler}; `type` arg is enum of `ROUTINE_TYPES`; ISO→Date parse+validate; rejects unknown tools; enforces offered-slots + in-conversation-hold gates; wraps unchanged 001 tools.
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
