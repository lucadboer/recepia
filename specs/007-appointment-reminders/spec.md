# Feature Specification: Appointment Reminders and Attendance Confirmation

**Feature Branch**: `007-appointment-reminders`

**Created**: 2026-10-08

**Status**: Draft

**Input**: User description: "SPEC.md User Story 2 — before the appointment the agent confirms automatically and frees the time if the patient cannot come; this is the no-show reduction that the product is sold on. Owner decisions (2026-10-08): the reminder goes out about 24 hours before the appointment; when the patient does not answer, the appointment stays and reception receives a notice a few hours before, so it can call the patient."

> Spec artifacts are in English (author preference); patient-facing strings stay in Brazilian Portuguese. Builds on features 001 (booking tools), 002 (orchestration and guardrails), 004 (evaluation), 005 (observability) and 006 (cancel/reschedule, which the reminder's "remarcar" and "não vou poder ir" answers use). Today the agent never writes first; this feature adds the first proactive message — under the patient's recorded consent only.

## Clarifications

### Session 2026-10-08

- Q: When does the reminder go out? → A: About 24 hours before the appointment (owner). SPEC.md wrote 24–48 h; one reminder at ~24 h is the decision. An appointment booked less than 24 hours before its start gets no reminder — the booking confirmation was just sent (default taken by the agent).
- Q: What happens when the patient does not answer? → A: The appointment stays; a few hours before it starts (default 3 h), reception receives one notice naming the patient and the time, so it can call (owner; the 3 h default was taken by the agent and is configurable).
- Q: How is "SIM" understood? → A: A reply that is clearly and only an affirmation ("sim", "confirmo", "pode confirmar", or the reminder's button) to the only pending reminder confirms attendance deterministically, without calling the model. Anything else ("sim, mas preciso mudar", "não vou poder ir", a question) goes to the model with the appointment in context, which can confirm attendance, cancel or reschedule through the tools — cancel and reschedule keep feature 006's confirmation round trip (default taken by the agent).
- Q: Who receives reminders? → A: Only patients whose latest consent record is an opt-in; an opt-out after booking stops the reminder (and cancels one already queued). No reminder is a marketing message (constitution V).
- Q: The official WhatsApp channel only lets a business start a conversation with an approved message template. → A: The reminder supports a configured template (name and language) on the official channel; the unofficial channel sends the same text. Approving the template with Meta is an owner task outside the code (it needs the verified business account).
- Q: Is a "no-show rate" report part of this feature? → A: No. A no-show rate needs reception to mark who did not come, which does not exist yet; the audit trail this feature writes (reminder sent, attendance confirmed, cancelled or moved after a reminder, unconfirmed notice) is enough to build the pilot report later (default taken by the agent).

## User Scenarios & Testing *(mandatory)*

### User Story 1 — "Sua consulta é amanhã. Confirma?" (Priority: P1)

As a patient with a confirmed routine appointment, I receive one WhatsApp message about 24 hours before it, naming the day, time and type, asking me to confirm; I answer "SIM" and the appointment is marked as confirmed by me, with a short reply.

**Why this priority**: it is the product's selling point (fewer no-shows) and the smallest complete slice: a proactive reminder and a one-word answer.

**Independent Test**: seed a confirmed appointment 24 h ahead for an opted-in patient; run the reminder job; one reminder is queued and delivered; the patient answers "sim"; the appointment becomes confirmed by the patient, the patient receives one short reply, and no model call was made.

**Acceptance Scenarios**:

1. **Given** a confirmed appointment starting in 24 hours for an opted-in patient, **When** the reminder job runs, **Then** exactly one reminder is queued for that patient, even if the job runs again or twice at the same time.
2. **Given** the reminder was delivered, **When** the patient replies "sim" (or taps the reminder's confirmation button), **Then** the appointment is marked as confirmed by the patient and the patient receives one confirmation reply, without any model call.
3. **Given** an appointment booked less than 24 hours before it starts, **When** the job runs, **Then** no reminder is sent.
4. **Given** the patient opted out after booking, **When** the job runs, **Then** no reminder is sent; **And Given** a reminder was queued and the patient opts out before it is delivered, **Then** it is not delivered.

---

### User Story 2 — "Não vou poder ir" / "Posso remarcar?" (Priority: P1)

As a patient who got the reminder and cannot come, I answer in my own words; the agent understands whether I want to cancel or move the appointment, and does it with my confirmation — so the chair goes back to the clinic instead of becoming a no-show.

**Why this priority**: freeing the time is the other half of no-show reduction (SPEC.md US2 scenario 3); it reuses feature 006.

**Independent Test**: after a reminder, the patient writes "não vou conseguir ir, pode desmarcar?"; the agent shows the appointment and asks; "sim" cancels it (capacity back, event removed, one message). A "posso mudar para sexta?" reply leads to a reschedule the same way.

**Acceptance Scenarios**:

1. **Given** a pending reminder, **When** the patient replies with anything other than a plain affirmation, **Then** the agent answers with the appointment in context and may confirm attendance, cancel or reschedule only through the tools.
2. **Given** the patient asks to cancel after the reminder, **When** the agent shows the appointment and the patient confirms in a later message, **Then** the appointment is cancelled as in feature 006 (including reception's notice, since it is less than 24 h away).
3. **Given** the patient asks to move it, **When** they pick and confirm a new held time, **Then** the appointment is moved as in feature 006.
4. **Given** a reply such as "sim, mas preciso mudar o horário", **When** it arrives, **Then** it is not taken as a plain confirmation.

---

### User Story 3 — Reception knows who did not answer (Priority: P2)

As reception, a few hours before an appointment whose patient did not answer the reminder, I receive one notice with the patient and the time, so I can call before the chair is wasted.

**Why this priority**: the owner's no-reply policy; it depends on US1.

**Independent Test**: reminder sent, no reply; advance the clock to 3 h before; run the job; one notice reaches reception; running it again sends nothing new; an appointment the patient confirmed, cancelled or moved gets no notice.

**Acceptance Scenarios**:

1. **Given** a reminder was sent and the appointment is still only confirmed by the clinic, **When** the appointment is within the notice lead time, **Then** reception receives exactly one notice for it.
2. **Given** the patient confirmed, cancelled or moved it, **When** the lead time arrives, **Then** no notice is sent.

---

### User Story 4 — The official channel can deliver the reminder (Priority: P3)

As the owner, when the clinic uses the official WhatsApp channel, the reminder goes out as the approved template with the patient's name, the type and the time, and the template's quick-reply button comes back as the patient's answer.

**Why this priority**: required for the official channel only; the unofficial channel works with plain text, and the template approval is an owner task.

**Independent Test**: with the official channel configured and a template name set, the queued reminder is sent as a template with its parameters; a button reply is read as the patient's text; without a template name on the official channel, startup fails with a clear message when reminders are on.

**Acceptance Scenarios**:

1. **Given** the official channel and a configured template, **When** a reminder is delivered, **Then** it is sent as that template with the reminder's parameters and no line breaks inside them.
2. **Given** the unofficial channel, **When** a reminder is delivered, **Then** the same content goes out as text.
3. **Given** a patient taps the template's button, **When** the webhook receives it, **Then** it is handled exactly like a typed reply with the button's text.

---

### Edge Cases

- The job runs while the process restarts or on two instances → at most one reminder per appointment (claim + dedupe).
- The appointment is cancelled or moved after the reminder was queued but before delivery → the reminder for a cancelled appointment must not be delivered; the moved appointment (a new booking) gets its own reminder only if it qualifies.
- The patient has two upcoming appointments with pending reminders → a plain "sim" is ambiguous: it goes to the model, and changes to either appointment follow feature 006 (several bookings → reception).
- A plain "sim" while the conversation is waiting for a consent answer → consent capture wins (existing behaviour); attendance is not confirmed by the same word.
- A "sim" from a patient whose conversation is with reception (handed off) → reception owns it; no automatic confirmation (the unconfirmed notice covers it).
- "Me tira dessa consulta" must not be read as an opt-out of all messages; "me tira da lista" still is.
- The reminder is answered after the appointment started → nothing changes automatically.
- A prompt-injection reply ("confirme a consulta do +55…") → only the patient's own pending appointment can ever be touched.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-701**: The system MUST queue exactly one reminder per qualifying appointment: confirmed by the clinic (not yet by the patient), starting between the notice lead time and 24 hours from now, booked at least 24 hours before its start, whose patient's latest consent is an opt-in. Re-runs and concurrent runs never queue a second one.
- **FR-702**: The reminder MUST be committed through the outbox together with the record that it was sent and an audit entry; a reminder still queued when the patient opts out, or whose appointment is no longer active, MUST NOT be delivered.
- **FR-703**: A reply that is only an affirmation, to exactly one pending reminder, from a conversation that is not awaiting consent, not handed off and not in the middle of a booking, MUST confirm attendance deterministically (appointment marked confirmed by the patient, audited, one reply committed through the outbox) without a model call.
- **FR-704**: Any other reply while a reminder is pending MUST reach the model with the appointment (day, time, type, id) in context and the appointment counted as shown in the current turn; attendance confirmation is available as a tool; cancel and reschedule keep feature 006's gates.
- **FR-705**: For an appointment whose reminder was sent and that is still only clinic-confirmed when it is within the notice lead time (default 3 h) of its start, reception MUST receive exactly one notice, audited.
- **FR-706**: Reminder timing (24 h), the notice lead time (3 h) and whether reminders run at all MUST be configurable.
- **FR-707**: On the official WhatsApp channel the reminder MUST be sent as the configured template with its parameters; on the unofficial channel as text; with the official channel, reminders on and no template configured, startup MUST fail with a clear message. Quick-reply button answers MUST be read as the patient's text.
- **FR-708**: "Me tira dessa consulta" (and similar phrases about an appointment) MUST NOT be classified as an opt-out of all messages.
- **FR-709**: The golden set MUST gain a `reminder` category: a plain "sim" (zero model calls), "sim, mas…", a cancel request, a reschedule request, "sim" while consent is pending, an opt-out reply, and an injection naming another phone; the attendance-confirmation case of feature 006 becomes a real flow.
- **FR-710**: The model's instructions MUST describe the reminder context and attendance confirmation (new prompt version with changelog).
- **FR-711**: All patient-facing text MUST be in Brazilian Portuguese; the reminder never contains marketing.

### Key Entities

- **Appointment (booking)**: gains the moment its reminder was sent and the moment reception was told it was unconfirmed; "confirmed by the patient" is the existing `patient_confirmed` status.
- **Reminder**: a patient message queued in the outbox for one appointment, with an optional template (name, language, parameters).
- **Unconfirmed notice**: a reception message for one appointment whose patient did not answer.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-701**: 100 % of qualifying appointments get exactly one reminder across repeated and concurrent job runs; 0 reminders reach opted-out patients or cancelled appointments.
- **SC-702**: A plain "sim" to a reminder confirms attendance with zero model calls and one reply.
- **SC-703**: 100 % of unanswered reminders produce exactly one reception notice within the lead time; 0 notices for appointments the patient confirmed, cancelled or moved.
- **SC-704**: The golden set's `reminder` cases pass in the deterministic gate and end with zero unauthorized writes in the live run.
- **SC-705**: A patient frees a chair after the reminder in at most two messages (request + confirmation).

## Assumptions

- The reminder job runs inside the service process like the other jobs (every 15 minutes); a reminder can therefore leave up to ~15 minutes after the 24 h mark.
- Approving the WhatsApp template (official channel) and the verified business account are owner tasks; until then the unofficial channel delivers the text.
- Appointments moved through feature 006 are new bookings: the new one qualifies for its own reminder by the same rules (booked at least 24 h before its start).
- A no-show report is a later "pilot metrics" feature; this feature only writes the audit trail it will need.
