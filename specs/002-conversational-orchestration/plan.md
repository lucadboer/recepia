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
