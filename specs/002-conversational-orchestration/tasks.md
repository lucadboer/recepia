# Tasks: Conversational Orchestration

**Tests**: REQUIRED (constitution Test-First). Behavioral tests assert tool/DB/fake side-effects, never LLM text. RED→GREEN per task. Conventional commit per phase; suite always green.

## Phase 0 — Spec (SDD gate)
- [x] T200 Author `specs/002-*` artifacts + update CLAUDE.md SPECKIT block (decisions deferred)

## Phase 1 — LLMPort + FakeLLM + conversation state
- [x] T201 [P] `src/ports/llm-port.ts`, `src/ports/conversation-store-port.ts`, `src/agent/types.ts`
- [x] T202 [P] `src/agent/conversation.ts` (pure reducers) + `tests/unit/conversation.test.ts` (RED first)
- [x] T203 [P] `src/adapters/fakes/{fake-llm,fake-conversation-store}.ts` + `tests/unit/fake-llm.test.ts`

## Phase 2 — Deterministic triage + intent (escalate-on-doubt backstop)
- [x] T204 `src/agent/triage.ts` + `tests/unit/triage.test.ts` (one case per trigger + negatives)
- [x] T205 `src/agent/intent.ts` + `tests/unit/intent.test.ts`

## Phase 3 — Tool registry + schemas + structural guardrails
- [x] T206 `src/agent/tool-schemas.ts`, `src/agent/reply.ts` + `tests/unit/reply.test.ts`
- [x] T207 `src/agent/tool-registry.ts` + `tests/integration/tool-registry.test.ts` (non-offered slot / foreign holdId / unknown tool rejected)

## Phase 4 — Consent
- [x] T208 `src/db/migrations/005_patient_consent.sql`, `src/db/repositories/consent-repo.ts`, `src/agent/consent.ts`; extend `AuditAction`; extend `resetDb`
- [x] T209 `tests/integration/consent.test.ts`

## Phase 5 — Orchestrator (keystone)
- [x] T210 `src/agent/orchestrator.ts`, `src/agent/system-prompt.ts`, `AgentDeps`, errors
- [x] T211 behavioral tests: book-happy, no-write-guardrail, confirm-requires-hold, slot-must-come-from-availability, triage-escalation (LLM not called), consent-gate, max-iterations, tool-error-recovery, idempotent-inbound

## Phase 6 — Inbound parsers
- [x] T212 `src/adapters/messaging/inbound/{evolution,cloud-api}-parser.ts` + fixtures + tests

## Phase 7 — Adapter scaffolds (needs-creds)
- [x] T213 `src/adapters/{llm/anthropic-llm,messaging/evolution-messaging,messaging/cloud-api-messaging,calendar/google-calendar}.ts` + `NotConfigured` + `tests/integration/adapter-scaffolds-notconfigured.test.ts`

## Phase 8 — Conversation DB scaffold
- [x] T214 `src/db/migrations/006_conversation_state.sql`, `src/db/repositories/conversation-repo.ts`, extend `resetDb`, finalize `quickstart.md` + `tests/integration/conversation-repo.test.ts`

## NEEDS-USER (do not decide)
Anthropic key+model (see `claude-api` skill), Google Calendar creds, WhatsApp Evolution+Cloud creds, live integration tests, patient/opt-in copy, LGPD retention, escalation routing, webhook hosting, final MAX_ITERATIONS.

## Phase 9 — Convergence (reconciled with real code, 2026-06-19)

> `/speckit-converge`: Phases 1–8 (T201–T214) are implemented and green (107 tests), so their checkboxes above were reconciled to `[x]` at the user's explicit request (a deliberate deviation from converge's append-only default). Below: list-B work already completed beyond the original scope (recorded as done), then the genuinely-remaining work as new traceable tasks for `/speckit-implement`. FR-201…FR-209 are fully satisfied by the implemented code (no findings); the items below are FR-210's remaining real adapters plus the spec's `[DEFERRED — NEEDS-USER]` set, now formalized.

### Completed beyond original scope (list B — done, validated live)
- [x] T215 Real `AnthropicLLM` adapter (Messages API tool-use, model `claude-sonnet-4-6`, thinking off) + `LIVE_LLM` smoke test, replacing the needs-creds scaffold, per FR-210 / plan: LLMPort real adapter (was scaffold). Validated live (commit 2809a0f).
- [x] T216 Real `GoogleCalendar` adapter (API v3, service-account key, least-privilege `calendar.events` scope, deterministic idempotent event id, 404/410-safe delete) + `LIVE_CALENDAR` smoke test, replacing the needs-creds scaffold, per FR-210 / plan: CalendarPort real adapter (was scaffold). Validated live (commit ad9f7ca).

### Open — remaining work
- [x] T217 Implement the real `EvolutionMessaging` outbound adapter (dev WhatsApp) replacing the `NotConfigured` scaffold; add a live test behind a `LIVE_*` flag, out of the default `pnpm test`, per FR-210 / plan: MessagingPort (Evolution) (partial)
- [ ] T218 Implement the real `CloudApiMessaging` outbound adapter (prod WhatsApp Cloud API — not open-wa) replacing the `NotConfigured` scaffold; add a live test behind a `LIVE_*` flag, per FR-210 / plan: MessagingPort (Cloud API) (partial)
- [x] T219 Add a composition root that builds `AgentDeps` from real adapters (`AnthropicLLM`, `GoogleCalendar`, real messaging, `DbConversationStore`, `pg` pool) and wires `handleInbound`; add a live end-to-end conversation test (availability → hold → confirm) behind a `LIVE_*` flag — no production wiring exists today (adapters are only built in tests), per US1 (live) / plan: orchestrator wiring (missing)
- [ ] T220 Finalize the patient-facing pt-BR copy (greeting, slot offer, confirmation request, recovery) in `reply.ts`/`system-prompt.ts`, per FR-208 / spec [DEFERRED] patient copy (partial; neutral placeholders present)
- [ ] T221 Finalize the LGPD legal opt-in/opt-out wording in the consent flow (`consent.ts`/`reply.ts`), per FR-205, Constitution V / spec [DEFERRED] legal copy (partial; `TODO(legal)` placeholder)
- [ ] T222 Define and implement LGPD retention/finalidade + a purge job for `conversation_state` and `patient_consent`, per Constitution V / spec [DEFERRED] retention (missing; no purge job)
- [ ] T223 Define the escalation routing policy (single number vs queue, business hours, hand-off tone) and wire it into `escalateToHuman`/reception notification, per FR-204 / spec [DEFERRED] routing (partial; escalation fires, routing target undecided)
- [x] T224 Webhook hosting: an HTTP entrypoint that verifies the provider signature, edge-dedupes, and calls `handleInbound` (deploy target), per FR-207, US1 / spec [DEFERRED] hosting (missing)
- [ ] T225 Set the final `AGENT_MAX_ITERATIONS`/per-conversation timeout (currently default 8) as a product/safety decision, per FR-206, SC-204 / spec [DEFERRED] (partial; sensible default in place, SC-204 bound already satisfied)
