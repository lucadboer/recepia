# Feature Specification: Reschedule and Cancel over WhatsApp

**Feature Branch**: `006-reschedule-cancel`

**Created**: 2026-10-08

**Status**: Draft

**Input**: User description: "SPEC.md User Story 3 — the patient reschedules or cancels an existing routine appointment over WhatsApp; capacity is released correctly; several bookings or an ambiguous request go to reception. Owner decisions (2026-10-08): the patient may cancel or reschedule at any time; when the change happens less than 24 hours before the appointment, reception is also notified."

> Spec artifacts are in English (author preference); patient-facing strings stay in Brazilian Portuguese. Builds on features 001 (deterministic booking tools: availability, hold, confirm, escalate), 002 (conversational orchestration and its structural guardrails), 004 (evaluation harness) and 005 (observability). Today every reschedule or cancel request is handed to reception (the `reschedule_cancel` golden cases encode that as a known limitation); this feature lets the agent do it autonomously — with the same rule that the model only proposes and deterministic tools write.

## Clarifications

### Session 2026-10-08

- Q: Until when may the patient cancel or reschedule alone over WhatsApp? → A: At any time before the appointment starts (owner). When the change happens less than 24 hours before the original appointment, reception also receives a notice so the chair can be re-offered.
- Q: How is the new time chosen in a reschedule? → A: Only from real availability shown in this conversation and held for the patient, exactly like a new booking (default taken by the agent; the owner may override). SPEC.md wrote `reschedule_booking(booking_id, new_slot)`; the new slot is a hold instead, so the existing "offered in this conversation" guardrail, the per-slot lock and the booking window all apply unchanged.
- Q: When is the old time released during a reschedule? → A: Only when the new time is confirmed, in the same step (default taken by the agent). SPEC.md US2-3 says the slot is "released and the reschedule flow starts"; releasing first could leave the patient with no appointment at all if no alternative fits. A patient who just cannot come uses cancel, which releases immediately.
- Q: How is "explicit confirmation before the commit" (constitution IV) enforced for cancel and reschedule? → A: Structurally: a cancel or reschedule never executes in the same turn in which the appointment (or, for a reschedule, the new held time) was first shown to the patient — the patient must have replied after seeing it (default taken by the agent). A booking's confirmation keeps today's rule; this feature does not change it.
- Q: Can a booking be rescheduled to a different appointment type? → A: No (default taken by the agent). Changing the type is a new booking; the agent offers that path or hands off.
- Q: Does cancelling require recorded consent? → A: No — cancelling reduces the data held and must work even after an opt-out (default taken by the agent). Rescheduling writes a new booking with the patient's data, so it requires consent like any booking.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Cancel my appointment (Priority: P1)

As a patient with a confirmed routine appointment, I want to write "preciso cancelar minha consulta" and have the agent find my appointment, ask me to confirm which one it is, and cancel it — so the chair goes back to the clinic's availability and I get a message saying it is cancelled.

**Why this priority**: a patient who cannot come and has no easy way to say so becomes a no-show; a freed chair can be offered to someone else. Cancelling is the smallest complete change to an existing booking.

**Independent Test**: seed one confirmed booking for the patient; run the conversation "quero cancelar" → agent shows the appointment and asks → "sim"; the booking is cancelled, its calendar event removed, the time is available again, the patient received one cancellation message, and the audit log has the cancellation.

**Acceptance Scenarios**:

1. **Given** the patient has exactly one upcoming confirmed appointment, **When** they ask to cancel, **Then** the agent shows that appointment (date, time, type) and asks for confirmation without cancelling yet.
2. **Given** the agent showed the appointment and asked, **When** the patient confirms, **Then** the appointment is cancelled, the time becomes available to other patients immediately, the calendar event is removed, and the patient receives exactly one cancellation message.
3. **Given** the appointment starts in less than 24 hours, **When** it is cancelled, **Then** reception also receives a notice identifying the freed time.
4. **Given** the cancellation was already done, **When** the same request is repeated (retry or duplicate message), **Then** nothing is written twice and no second message is sent.
5. **Given** removing the calendar event keeps failing, **When** the cancellation is committed, **Then** the booking stays cancelled in the clinic's system of record and reception is asked to remove the event by hand.

---

### User Story 2 — Move my appointment to another time (Priority: P1)

As a patient, I want to say "posso mudar para quinta à tarde?" and have the agent find my appointment, show me real free times, hold the one I pick, and — after I confirm — move my appointment there, so I never end up with two appointments or none.

**Why this priority**: rescheduling keeps the patient instead of losing them to a cancel; it is the other half of SPEC.md US3 and the path the reminder (feature 007) sends "remarcar" replies to.

**Independent Test**: seed one confirmed booking; run "quero remarcar" → agent shows the appointment → availability → patient picks → hold → "sim"; the old time is free, the new time is booked with a calendar event, the old event is gone, the patient got one message about the new time, and the audit links the new booking to the old one.

**Acceptance Scenarios**:

1. **Given** the patient has one upcoming appointment, **When** they ask to move it, **Then** the agent shows it and offers only times returned by the availability check, of the same appointment type.
2. **Given** the patient picked a time and the agent held it and asked for confirmation, **When** the patient confirms, **Then** in one step the new appointment is confirmed and the old one released; the patient receives exactly one message with the new time.
3. **Given** the new time cannot be written to the calendar, **When** the reschedule is attempted, **Then** the old appointment stays exactly as it was, the held time is released, and the conversation goes to reception.
4. **Given** the held time expired or was taken before the patient confirmed, **When** the reschedule is attempted, **Then** the old appointment stays as it was and the agent offers other times.
5. **Given** the original appointment starts in less than 24 hours, **When** it is moved, **Then** reception also receives a notice.
6. **Given** the patient opted out of data processing, **When** they ask to reschedule, **Then** the agent asks for consent before confirming the new time (a cancel would not need it).

---

### User Story 3 — Hand off when it is not clear which appointment (Priority: P2)

As reception, I want the agent to hand the conversation to me — instead of guessing — when the patient has no upcoming appointment the agent can find, or more than one, so a human resolves the ambiguous cases (SPEC.md US3 scenario 3).

**Why this priority**: guessing which appointment to cancel is exactly the failure the constitution forbids (IV, escalate on doubt); it is rarer than the single-appointment case, so it follows P1.

**Independent Test**: seed two upcoming bookings for the patient (and, separately, none); ask to cancel; the conversation is handed to reception with the reason, and nothing is cancelled.

**Acceptance Scenarios**:

1. **Given** the patient has two or more upcoming appointments, **When** they ask to cancel or move one, **Then** the conversation is handed to reception and nothing changes.
2. **Given** the patient has no upcoming appointment the agent can find (e.g. it was booked by phone directly in the calendar), **When** they ask to cancel or move, **Then** the conversation is handed to reception and nothing changes.

---

### Edge Cases

- The patient names an appointment id or a time the agent never showed in this conversation (prompt injection or hallucination) → refused, nothing written.
- The model tries to cancel or move another patient's appointment → refused, nothing written, even if it somehow knows the id.
- The model tries to cancel in the same turn it found the appointment ("pode cancelar" in the first message) → refused; the agent must ask and wait for the reply.
- The appointment already started or is in the past → refused with a clear message; reception if the patient insists.
- The appointment was already cancelled or moved by a concurrent request → the repeated request is answered idempotently; nothing is duplicated.
- A cancel and a reschedule of the same appointment race → exactly one wins; calendar events match active bookings afterwards.
- A reschedule to the same time as the current appointment → refused.
- A reschedule to a different appointment type → refused; the agent offers a new booking path or reception.
- The conversation was handed to reception → no cancel or reschedule runs after the hand-off (existing rule).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-601**: The agent MUST be able to look up the patient's upcoming appointment using only the phone number of the conversation (never one supplied by the model). Exactly one upcoming confirmed appointment → it is shown to the patient and remembered as shown in this conversation; none or more than one → the conversation is handed to reception with the reason, by the system rather than by the model's judgement.
- **FR-602**: A cancel or reschedule MUST only act on an appointment that (a) belongs to the conversation's phone, (b) was shown by the lookup in this conversation, (c) is still upcoming and confirmed. Anything else is refused with no write.
- **FR-603**: A cancel or reschedule MUST NOT execute in the same patient turn in which the appointment — or, for a reschedule, the new held time — was first shown; the patient must have replied after seeing it.
- **FR-604**: Cancelling MUST, in one atomic step, mark the appointment cancelled (its capacity immediately available), record an audit entry, and commit the patient's cancellation message; the calendar event is then removed. If removal keeps failing, the appointment stays cancelled and reception receives a notice to remove the event by hand.
- **FR-605**: Rescheduling MUST take the new time only from a hold created in this conversation from availability shown in this conversation, of the same appointment type and a different time; it MUST write the new calendar event first, then — in one atomic step — confirm the new appointment, cancel the old one, record audit entries linking them, and commit the patient's message; then remove the old event (same failure path as FR-604). If the new event cannot be written, the old appointment is untouched, the hold is released and the conversation goes to reception. At most one reschedule of the same appointment can ever succeed.
- **FR-606**: When a cancel or reschedule happens less than 24 hours before the original appointment's start, reception MUST also receive a notice (in the same atomic step as the change).
- **FR-607**: Rescheduling MUST require recorded consent (the same gate as a new booking); cancelling MUST NOT.
- **FR-608**: Repeating a cancel or reschedule that already succeeded MUST return the existing result without new writes, events or messages.
- **FR-609**: Every write of this feature MUST be audited in the same transaction as the change, with the prompt version for model-initiated writes; the reschedule audit links the new appointment to the old one.
- **FR-610**: Each new refusal MUST be observable as a guardrail outcome on the tool step of the trace (005): appointment not shown in this conversation, confirmation still required, appointment of another patient.
- **FR-611**: The model's instructions MUST describe cancel and reschedule (new prompt version with changelog); attendance confirmation ("vou sim") still goes to reception until feature 007.
- **FR-612**: The golden set MUST cover the new behaviour: the existing `reschedule_cancel` cases become real flows (except attendance confirmation), plus adversarial cases for an id never shown, another patient's id, a same-turn cancel, two appointments, no appointment, a late cancel, a time taken mid-flow, and an opted-out patient.
- **FR-613**: All patient-facing text MUST be in Brazilian Portuguese.

### Key Entities

- **Appointment (booking)**: gains a cancellation moment and, when it replaced another appointment, a link to the appointment it replaced. Lifecycle: held → confirmed → cancelled (by the patient) or replaced by a new appointment (reschedule).
- **Shown appointment (conversation memory)**: which appointment the lookup showed in this conversation and in which turn — the basis of FR-602 and FR-603.
- **Reception notice**: a message to reception about a late change or a calendar event to remove by hand; committed atomically with the change that caused it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-601**: After a cancel, the freed time is offered by the very next availability check (0 delay).
- **SC-602**: Under concurrent holds, cancels and reschedules of the same times, no time ever exceeds its capacity and at most one reschedule of an appointment succeeds (concurrency test, 100 % of runs).
- **SC-603**: 100 % of adversarial reschedule/cancel cases end with zero unauthorized writes in the deterministic gate and in the live run.
- **SC-604**: After any tested sequence of cancels, reschedules and failures, the calendar holds exactly one event per active appointment, or reception has a notice for each difference.
- **SC-605**: In 100 % of tested conversations, no cancel or reschedule executes in the turn in which its appointment or new time was first shown.
- **SC-606**: A patient completes a cancel in two messages and a reschedule in at most four (request, pick, confirm — plus one if the agent must ask the type or day).

## Assumptions

- Appointments booked directly in the calendar (outside the agent) are not visible to the lookup — there is no calendar-to-system sync; such requests go to reception (US3).
- The patient's name on the new appointment is copied from the old one; the model never supplies it in a reschedule.
- The 10-minute hold must survive the confirmation turn of a reschedule, exactly as for a new booking today.
- Reminders and attendance confirmation are feature 007; the reminder's "remarcar" reply will use this feature's reschedule.
- A completed cancel or reschedule ends the conversation like a completed booking does (the next message starts fresh).
