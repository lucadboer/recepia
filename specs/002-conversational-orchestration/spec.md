# Feature Specification: Conversational Orchestration over the Deterministic Booking Tools

**Feature**: `002-conversational-orchestration` · builds on `001-autonomous-routine-booking`

**Created**: 2026-06-19

**Status**: Draft (product/legal/model decisions marked `[DEFERRED — NEEDS-USER]`)

> Spec artifacts in English (author preference); patient-facing strings stay pt-BR. This slice adds the **language layer** on top of the already-built, fully-tested deterministic tools. It is built and tested entirely **behind ports with fakes — no secrets, no network**. Real adapters (Anthropic, Google Calendar, WhatsApp) are scaffolds behind a needs-creds boundary; live calls are deferred.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Book by chatting (Priority: P1)
A patient messages on WhatsApp; the agent understands the request, offers genuinely free slots (only from `get_availability`), reserves one, asks for explicit confirmation, captures opt-in consent, and confirms — writing exactly one calendar event and a pt-BR confirmation. No human intervention.

**Independent Test (behavioral)**: drive `handleInbound` with a scripted `FakeLLM` (availability → hold → confirm) and assert tool side-effects: one `FakeCalendar` event, one `FakeMessaging` patient message, `hold_created` + `booking_confirmed` audit rows. Never assert LLM text.

**Acceptance Scenarios**:
1. **Given** capacity and recorded consent, **When** the conversation reaches confirmation, **Then** exactly one booking + event + pt-BR confirmation are produced.
2. **Given** the model proposes a slot never returned by `get_availability`, **When** it tries to hold it, **Then** the orchestrator rejects it and nothing is written.
3. **Given** the model tries to confirm a `holdId` not created in this conversation, **When** dispatched, **Then** it is rejected and no event is written.

### User Story 2 — Escalate on doubt (Priority: P1)
Any message with an escalation signal (urgency/pain, specialized procedure, ongoing treatment, specific-professional, complaint, financial, ambiguity, non-routine) is escalated to reception **without invoking the LLM** and without creating a booking.

**Independent Test**: inbound "estou com muita dor" → `escalateToHuman` fired, reception notified, `escalated` audit row, patient gets a pt-BR hand-off message, and `FakeLLM` was never called.

### User Story 3 — Consent gate (Priority: P1)
No booking is committed before the patient's opt-in is recorded; opt-out is honored and audited.

**Independent Test**: with no prior consent, even a scripted confirm produces no calendar event until consent is recorded; after opt-in, confirm succeeds; opt-out flips state and is audited.

### Edge Cases
- Duplicate inbound (`providerMessageId` re-delivery) → no-op (idempotent).
- LLM loops without finishing → bounded by `MAX_ITERATIONS` → escalate + pt-BR fallback.
- Tool error (`SlotUnavailableError`/`HoldExpiredError`/`OutOfScopeError`/`CalendarWriteError`) → mapped to pt-BR recovery, fed back so the model re-plans; `CalendarWriteError` already escalates inside the tool (no double-escalate).
- Non-text inbound (audio/image) → ignored by parsers; placeholder pt-BR "só texto por enquanto".

## Requirements *(mandatory)*

- **FR-201**: The system MUST drive the conversation through an LLM that can ONLY act via the deterministic tools of feature 001 (closed allowlist). No direct DB/calendar writes.
- **FR-202**: Every slot offered or held MUST originate from a `get_availability` result in the same conversation (no model-invented times).
- **FR-203**: `confirm_booking` MUST only be dispatched for a hold created earlier in the same conversation (structural form of explicit-confirmation-before-commit).
- **FR-204**: The system MUST escalate to reception, deterministically and before invoking the LLM, on any escalation signal (full list in [data-model.md](data-model.md)); escalation creates no booking.
- **FR-205**: The system MUST record patient opt-in consent before committing a booking, and MUST honor opt-out; both are audited.
- **FR-206**: The LLM tool-use loop MUST be bounded (`MAX_ITERATIONS`); on exhaustion it escalates and sends a pt-BR fallback.
- **FR-207**: Inbound delivery MUST be idempotent per `providerMessageId`.
- **FR-208**: All patient-facing messages MUST be pt-BR.
- **FR-209**: Tool errors MUST be mapped to pt-BR recovery messages and surfaced to the loop; never swallowed.
- **FR-210**: Real integrations (LLM, Calendar, WhatsApp) MUST sit behind ports; scaffolds throw `NotConfigured` without credentials (no silent no-op).

## Success Criteria *(mandatory)*
- **SC-201**: 100% of conversational bookings go through availability → hold → confirm in order; zero writes bypass the tools (proven by hostile-FakeLLM tests).
- **SC-202**: 100% of escalation-signal messages escalate without an LLM call and without a booking.
- **SC-203**: 0 bookings committed without a recorded consent.
- **SC-204**: The LLM loop never exceeds `MAX_ITERATIONS`.
- **SC-205**: The feature-001 concurrency/anti-overbooking guarantee remains green.

## Assumptions
- Inbound = pure per-provider parsers + `handleInbound` entrypoint; `MessagingPort` stays outbound-only (resolves 001's deferred `onMessage`).
- Consent required before `confirm` (browsing/holding collect the minimum); consent is a repo (not a port).
- `[DEFERRED — NEEDS-USER]`: model id/params, patient copy, opt-in legal copy, LGPD retention/finalidade, escalation routing, webhook hosting, live integration creds.
