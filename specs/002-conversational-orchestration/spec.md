# Feature Specification: Conversational Orchestration over the Deterministic Booking Tools

**Feature**: `002-conversational-orchestration` · builds on `001-autonomous-routine-booking`

**Created**: 2026-06-19

**Status**: Draft (product/legal/model decisions marked `[DEFERRED — NEEDS-USER]`)

> Spec artifacts in English (author preference); patient-facing strings stay pt-BR. This slice adds the **language layer** on top of the already-built, fully-tested deterministic tools. It is built and tested entirely **behind ports with fakes — no secrets, no network**. The real adapters (Anthropic, Google Calendar, WhatsApp Cloud API / Evolution) are implemented behind the same ports, fail fast with `NotConfigured` without credentials, and are exercised by the opt-in live suite (`tests/live`, `LIVE_*` flags).

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

**Acceptance Scenarios** (hand-off; added 2026-10-05, Phase 11):
1. **Given** any escalation, **When** reception is notified, **Then** the notification carries the patient's phone, the reason, the triggering context, and a short excerpt of the last patient/assistant messages (FR-204).
2. **Given** a conversation already handed off (`status = escalated`), **When** the patient sends another message, **Then** the LLM is not called, reception is not notified again, and the patient receives at most one pt-BR "a recepção vai continuar" notice per notice interval (FR-211).
3. **Given** a handed-off conversation, **When** the patient sends an opt-out, **Then** the opt-out is recorded and audited exactly as in an active conversation (FR-205 still applies).
4. **Given** a handed-off conversation, **When** reception releases it (CLI or optional auto-release TTL), **Then** the next patient message starts a fresh autonomous conversation (FR-211).
5. **Given** a `completed` conversation (booking confirmed), **When** the patient writes again, **Then** a fresh conversation starts; previously processed message ids are still deduplicated (FR-212).

### User Story 3 — Consent gate (Priority: P1)
No booking is committed before the patient's opt-in is recorded; opt-out is honored and audited.

**Independent Test**: with no prior consent, even a scripted confirm produces no calendar event until consent is recorded; after opt-in, confirm succeeds; opt-out flips state and is audited.

### Edge Cases
- Duplicate inbound (`providerMessageId` re-delivery) → no-op (idempotent).
- LLM loops without finishing → bounded by `MAX_ITERATIONS` → escalate + pt-BR fallback.
- Tool error (`SlotUnavailableError`/`HoldExpiredError`/`OutOfScopeError`/`CalendarWriteError`) → mapped to pt-BR recovery, fed back so the model re-plans; `CalendarWriteError` already escalates inside the tool (no double-escalate).
- Non-text inbound (audio/image) → ignored by parsers; placeholder pt-BR "só texto por enquanto".
- Patient confirmation or reception notification fails to send after the booking/escalation is committed → the message is retried with backoff; after the retry budget it is dead-lettered, audited, and reception is notified (FR-214). The booking is never silently confirmed without a delivery attempt trail.
- Two messages from the same patient processed concurrently by different processes → the second save fails loudly (`ConversationConflictError`), is logged, and no patient message is sent for the lost turn; in-process, messages from the same phone are serialized so this only happens across processes.
- Webhook body above the size limit → 413; malformed JSON → 400; a path that merely shares a prefix with a webhook path → 404.
- A conversation whose state grows past the configured bounds (history, offered slots, dedupe ids) is trimmed deterministically; trimming never splits a tool call from its result and never drops a slot the patient can still book.

## Requirements *(mandatory)*

- **FR-201**: The system MUST drive the conversation through an LLM that can ONLY act via the deterministic tools of feature 001 (closed allowlist). No direct DB/calendar writes.
- **FR-202**: Every slot offered or held MUST originate from a `get_availability` result in the same conversation (no model-invented times).
- **FR-203**: `confirm_booking` MUST only be dispatched for a hold created earlier in the same conversation (structural form of explicit-confirmation-before-commit).
- **FR-204** *(amended 2026-10-05)*: The system MUST escalate to reception, deterministically and before invoking the LLM, on any escalation signal (full list in [data-model.md](data-model.md)); escalation creates no booking. Every reception notification MUST include the patient's phone, the reason, the triggering context, and a deterministic excerpt of the recent conversation (no LLM-generated summary).
- **FR-205**: The system MUST record patient opt-in consent before committing a booking, and MUST honor opt-out; both are audited. *(Decided 2026-10-06)* Opt-out stops proactive messages (queued notifications are cancelled) and blocks `confirm_booking`; the agent still answers messages the patient sends.
- **FR-206**: The LLM tool-use loop MUST be bounded (`MAX_ITERATIONS`); on exhaustion it escalates and sends a pt-BR fallback.
- **FR-207**: Inbound delivery MUST be idempotent per `providerMessageId`.
- **FR-208**: All patient-facing messages MUST be pt-BR.
- **FR-209**: Tool errors MUST be mapped to pt-BR recovery messages and surfaced to the loop; never swallowed.
- **FR-210**: Real integrations (LLM, Calendar, WhatsApp) MUST sit behind ports; scaffolds throw `NotConfigured` without credentials (no silent no-op).
- **FR-211** *(2026-10-05)*: After an escalation the conversation MUST enter a handed-off state in which the LLM is not invoked and reception is not re-notified. The patient receives at most one pt-BR notice per notice interval. The state is left only when reception releases the conversation (operator command) or, if configured, after an auto-release TTL. Opt-out is honoured while handed off.
- **FR-212** *(2026-10-05)*: A `completed` conversation MUST start fresh on the patient's next message while keeping the already-processed message ids for deduplication.
- **FR-213** *(2026-10-05; amended 2026-10-07)*: All clinic-local time computations and patient-facing dates MUST use the clinic's IANA timezone (`America/Sao_Paulo`), never a fixed UTC offset. The LLM MUST be told the current date, weekday, time and timezone so it can produce correct ISO ranges. Tool results handed to the LLM MUST express times in clinic-local ISO 8601 with the offset plus a pt-BR label, so the model never converts UTC in front of the patient (the 004 live baseline caught replies such as "Os horários vêm em UTC… convertendo para Brasília").
- **FR-214** *(2026-10-05)*: Patient confirmations and reception notifications MUST be committed in the same transaction as the write they announce and delivered at-least-once with retries. After the retry budget the message is marked failed, audited, and reception is notified; no committed booking is left without a delivery trail.

## Success Criteria *(mandatory)*
- **SC-201**: 100% of conversational bookings go through availability → hold → confirm in order; zero writes bypass the tools (proven by hostile-FakeLLM tests).
- **SC-202**: 100% of escalation-signal messages escalate without an LLM call and without a booking.
- **SC-203**: 0 bookings committed without a recorded consent.
- **SC-204**: The LLM loop never exceeds `MAX_ITERATIONS`.
- **SC-205**: The feature-001 concurrency/anti-overbooking guarantee remains green.
- **SC-206** *(2026-10-05)*: Every `booking_confirmed` and `escalated` audit row references an outbox message that ends `sent`, or `failed` with an `outbox_dead_letter` audit row and a reception notification.
- **SC-207** *(2026-10-05)*: After a hand-off, zero LLM calls and zero additional reception notifications occur for that phone until release.

## Assumptions
- Inbound = pure per-provider parsers + `handleInbound` entrypoint; `MessagingPort` stays outbound-only (resolves 001's deferred `onMessage`).
- Consent required before `confirm` (browsing/holding collect the minimum); consent is a repo (not a port).
- Decided on 2026-10-06 (owner): patient copy = current wording (T220); opt-in/opt-out wording accepted, counsel review recommended before a pilot (T221); retention = purge `conversation_state`/`outbox_message` after 90 days of inactivity, keep `patient_consent` and `audit_log` (T222, job in feature 005 — implemented; re-confirmed 2026-10-07: escalation rows in `audit_log` keep their context and excerpt); escalation routing = single reception number, any hour, CLI release (T223); `AGENT_MAX_ITERATIONS = 8` final (T225); opt-out keeps the agent answering (T247). Live credentials and webhook hosting are configured per environment.
