# Tasks: Conversational Orchestration

**Tests**: REQUIRED (constitution Test-First). Behavioral tests assert tool/DB/fake side-effects, never LLM text. RED→GREEN per task. Conventional commit per phase; suite always green.

## Phase 0 — Spec (SDD gate)
- [x] T200 Author `specs/002-*` artifacts + update CLAUDE.md SPECKIT block (decisions deferred)

## Phase 1 — LLMPort + FakeLLM + conversation state
- [ ] T201 [P] `src/ports/llm-port.ts`, `src/ports/conversation-store-port.ts`, `src/agent/types.ts`
- [ ] T202 [P] `src/agent/conversation.ts` (pure reducers) + `tests/unit/conversation.test.ts` (RED first)
- [ ] T203 [P] `src/adapters/fakes/{fake-llm,fake-conversation-store}.ts` + `tests/unit/fake-llm.test.ts`

## Phase 2 — Deterministic triage + intent (escalate-on-doubt backstop)
- [ ] T204 `src/agent/triage.ts` + `tests/unit/triage.test.ts` (one case per trigger + negatives)
- [ ] T205 `src/agent/intent.ts` + `tests/unit/intent.test.ts`

## Phase 3 — Tool registry + schemas + structural guardrails
- [ ] T206 `src/agent/tool-schemas.ts`, `src/agent/reply.ts` + `tests/unit/reply.test.ts`
- [ ] T207 `src/agent/tool-registry.ts` + `tests/integration/tool-registry.test.ts` (non-offered slot / foreign holdId / unknown tool rejected)

## Phase 4 — Consent
- [ ] T208 `src/db/migrations/005_patient_consent.sql`, `src/db/repositories/consent-repo.ts`, `src/agent/consent.ts`; extend `AuditAction`; extend `resetDb`
- [ ] T209 `tests/integration/consent.test.ts`

## Phase 5 — Orchestrator (keystone)
- [ ] T210 `src/agent/orchestrator.ts`, `src/agent/system-prompt.ts`, `AgentDeps`, errors
- [ ] T211 behavioral tests: book-happy, no-write-guardrail, confirm-requires-hold, slot-must-come-from-availability, triage-escalation (LLM not called), consent-gate, max-iterations, tool-error-recovery, idempotent-inbound

## Phase 6 — Inbound parsers
- [ ] T212 `src/adapters/messaging/inbound/{evolution,cloud-api}-parser.ts` + fixtures + tests

## Phase 7 — Adapter scaffolds (needs-creds)
- [ ] T213 `src/adapters/{llm/anthropic-llm,messaging/evolution-messaging,messaging/cloud-api-messaging,calendar/google-calendar}.ts` + `NotConfigured` + `tests/integration/adapter-scaffolds-notconfigured.test.ts`

## Phase 8 — Conversation DB scaffold
- [ ] T214 `src/db/migrations/006_conversation_state.sql`, `src/db/repositories/conversation-repo.ts`, extend `resetDb`, finalize `quickstart.md` + `tests/integration/conversation-repo.test.ts`

## NEEDS-USER (do not decide)
Anthropic key+model (see `claude-api` skill), Google Calendar creds, WhatsApp Evolution+Cloud creds, live integration tests, patient/opt-in copy, LGPD retention, escalation routing, webhook hosting, final MAX_ITERATIONS.
