# Feature Specification: Autonomous Routine Appointment Booking via WhatsApp (no overbooking)

**Feature Branch**: `001-autonomous-routine-booking`

**Created**: 2026-06-18

**Status**: Draft

**Input**: User description: "Agendamento autônomo de consulta de rotina via WhatsApp (User Story 1 do SPEC.md): paciente pede horário, o sistema consulta disponibilidade real por capacidade, reserva com hold atômico, confirma e grava no Google Calendar, sem overbooking. Use o SPEC.md da raiz como base (modelo de capacidade pooled, modelo de dados, contratos das ferramentas). Começar pela camada determinística, sem LLM, integrações atrás de ports."

> Note: Spec artifacts are written in English by author preference (token economy). Patient-facing product strings remain in Portuguese — see FR-019. The ratified [SPEC.md](../../SPEC.md) and [constitution.md](../../.specify/memory/constitution.md) stay in Portuguese.

## Clarifications

### Session 2026-06-18

- Q: Appointment duration and slot grid for routine types (evaluation, cleaning, follow-up, consultation)? → A: Uniform 30 minutes for every type in the MVP, on a 30-minute grid (per-type durations deferred).
- Q: How long does the temporary hold reserve a slot awaiting the patient's explicit confirmation? → A: 10 minutes.
- Q: Minimum lead time and maximum window for offered slots? → A: At least 2 hours ahead; horizon up to 30 days.
- Q: What should happen if writing the event to Google Calendar fails at confirmation? → A: Retry briefly; if it persists, escalate to reception and release the hold — never confirm to the patient without the event written.

## User Scenarios & Testing *(mandatory)*

This feature corresponds to **User Story 1 of the [SPEC.md](../../SPEC.md)** — autonomously booking a routine appointment. It is decomposed below into independently testable journeys, each delivering value on its own.

### User Story 1 - Book an available routine slot (Priority: P1)

A patient messages the clinic on WhatsApp, at any time, asking to book a routine appointment (e.g., a cleaning). The agent understands the request, offers slots that are **genuinely free**, and once the patient picks one and explicitly confirms, the appointment is written to the clinic's calendar and the patient gets a confirmation — with no human intervention.

**Why this priority**: It is the sellable core and the demo. On its own it justifies the system: it captures bookings outside reception hours and frees the staff from manual work. Every other journey builds on this one.

**Independent Test**: Send a message requesting a cleaning, confirm an offered slot, and verify that (a) the event was written to the clinic calendar, (b) the patient received a confirmation, (c) nothing required a human.

**Acceptance Scenarios**:

1. **Given** there is free capacity in a routine slot, **When** the patient asks to book a cleaning and explicitly confirms an offered slot, **Then** the appointment is written to the clinic calendar and the patient receives a confirmation in Portuguese.
2. **Given** two (or more) patients targeting the same slot at the same time, **When** they all confirm simultaneously, **Then** at most the slot's capacity is written and the others receive real alternative slots — overbooking never occurs.
3. **Given** the patient was offered a slot and took longer to reply than the temporary hold's expiry, **When** they finally confirm, **Then** the system does not write into the expired slot, warns the patient, and offers fresh real slots.
4. **Given** a routine appointment request, **When** the booking is committed, **Then** the operation is recorded in the audit trail, marked as created by the agent (not by a human).

---

### User Story 2 - Receive real alternatives when the requested period is full (Priority: P2)

The patient asks for a specific slot (e.g., "tomorrow morning") that has no capacity. Instead of refusing or inventing one, the agent offers the next genuinely free slots.

**Why this priority**: Without it the agent stalls whenever the desired slot is full, sharply lowering conversion. It depends on US1 existing but complements it in an independently testable way.

**Independent Test**: Exhaust a period's capacity, request a slot in that period, and verify the agent replies with the next real free slots (no full or out-of-hours slot ever appears in the offer).

**Acceptance Scenarios**:

1. **Given** there is no capacity in the requested period, **When** the patient insists on booking, **Then** the agent offers the next real free slots within the booking horizon.
2. **Given** the whole period is full, **When** the agent searches for alternatives, **Then** no offered slot is outside business hours nor already full.
3. **Given** there is no free slot within the booking horizon at all, **When** the agent finds no alternatives, **Then** the request is escalated to reception instead of leaving the patient without an answer.

---

### User Story 3 - Escalate non-routine requests to reception (Priority: P2)

When the patient asks for something that is not a routine appointment (e.g., Invisalign, orthodontics, pain/urgency, insurance or pricing questions), the agent does not try to book: it hands off to a human.

**Why this priority**: It is the safety net that makes autonomy acceptable in a clinical context (the non-negotiable "Escalate When in Doubt" principle). US1's happy path demonstrates value without it, but no real-patient pilot runs without this protection.

**Independent Test**: Send an Invisalign (or urgency/pain) request and verify that no booking is created and that reception is notified with the context.

**Acceptance Scenarios**:

1. **Given** a non-routine request (e.g., Invisalign), **When** the patient sends it, **Then** the agent escalates to reception without attempting to book and without creating any hold.
2. **Given** an ambiguous request, or one with signs of urgency/pain, a specialized procedure, ongoing treatment, a specific-professional request, a complaint, or a financial matter, **When** the agent detects the signal, **Then** it escalates to reception instead of guessing.
3. **Given** any escalation, **When** it happens, **Then** reception is notified with the conversation context and the event is recorded in the audit trail.

---

### Edge Cases

- **Concurrency on the same slot**: N patients confirm the same slot at the same time → at most the capacity is written; the surplus receive alternatives. (Central guarantee; becomes a mandatory concurrency test per the constitution.)
- **Expired temporary hold**: the patient confirms after the deadline → the system explicitly refuses, does not write, warns, and re-offers slots.
- **Repeated confirmation / duplicate message**: the patient (or a channel re-delivery) confirms twice → exactly one appointment and one event are created (idempotency).
- **Same patient holding the same slot twice**: does not create a duplicate hold.
- **Period with no capacity**: offer the next real slots; if none within the horizon → escalate.
- **Day capacity set to zero** (clinic closed, override = 0): no slot is offered for that period.
- **Request received outside business hours**: accepted and processed normally (24/7 operation).
- **Failure writing to the clinic calendar** (integration unavailable): the system retries briefly; if it still fails, it escalates to reception and releases the hold, and never confirms to the patient without the event written.
- **Message mixing routine + out-of-scope**: when in doubt, escalate.
- **New patient with no recorded consent**: obtain consent (opt-in) and collect the minimum necessary before persisting personal data.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST offer the patient only genuinely available slots, computed from the current capacity, existing appointments, and active temporary holds for each slot.
- **FR-002**: The system MUST respect the clinic's business hours and the appointment type's duration when computing availability — never offering a slot outside business hours or that cannot fit the duration. In the MVP every routine type uses a uniform 30-minute duration on a 30-minute slot grid (per-type durations deferred).
- **FR-003**: The system MUST apply a day's one-off capacity adjustments (override) on top of the default capacity rule when present.
- **FR-004**: When the patient picks a slot, the system MUST create an atomic temporary hold, with a 10-minute expiry deadline, that counts against the slot's capacity while active.
- **FR-005**: The system MUST guarantee that concurrent requests for the same slot never exceed capacity — at most the slot's capacity can be held and/or confirmed at any moment (no overbooking).
- **FR-006**: Unconfirmed temporary holds MUST expire automatically at the end of the deadline, releasing the capacity.
- **FR-007**: The system MUST require the patient's explicit confirmation before committing any booking.
- **FR-008**: On confirmation, the system MUST write exactly one event to the clinic calendar and send the patient a confirmation message.
- **FR-009**: Hold and confirmation operations MUST be idempotent — a repetition (re-delivery, double tap, retry) does not create a duplicate hold, appointment, or event.
- **FR-010**: Attempting to confirm an expired or invalid hold MUST fail explicitly and recoverably (the patient is warned and offered fresh slots), never writing silently.
- **FR-011**: When there is no capacity in the requested period, the system MUST offer the next real free slots within the booking horizon.
- **FR-012**: The system MUST identify requests that are not routine appointments and escalate them to reception without attempting to book and without creating holds.
- **FR-013**: The system MUST escalate to a human on ambiguity, urgency/pain, a specialized procedure (e.g., Invisalign, orthodontics, implant, surgery), ongoing treatment, a specific-professional request, a complaint, or a financial matter.
- **FR-014**: When no free slot exists within the booking horizon, the system MUST escalate the request to reception instead of leaving the patient without an answer.
- **FR-015**: The system MUST record every write operation (hold, confirmation, hold release, escalation) in an append-only audit trail.
- **FR-016**: The system MUST record, for each appointment, whether it was created by the agent or by a human.
- **FR-017**: Booking MUST NOT depend on any slot inferred by the language layer — every offered and written slot comes exclusively from the deterministic availability query.
- **FR-018**: The system MUST accept and process requests at any time of day, every day (24/7 operation).
- **FR-019**: Every patient-facing message MUST be in Portuguese.
- **FR-020**: The system MUST collect only the minimum data needed to book (name, phone, and appointment type) and record the patient's consent (opt-in) for processing that data. *Note: the deterministic tools assume consent was captured upstream by the conversational layer and persist it as `consent_at`; enforcing the opt-in capture flow itself is owned by that later slice.*
- **FR-021**: If writing the event to the clinic calendar fails at confirmation, the system MUST retry briefly; if it still fails, it MUST escalate to reception and release the hold, and MUST NOT send a confirmation to the patient (no confirmation without a written event).
- **FR-022**: The system MUST only offer slots at least 2 hours ahead of the current time and no more than 30 days into the future (the booking horizon).

### Key Entities *(include if feature involves data)*

- **Capacity rule**: defines the default serving capacity per weekday and time range (e.g., Mon–Fri, 09:00–18:00, capacity 2). Bounded by the number of chairs. *Pooled* model — it is a slot counter, not a binding to a specific professional.
- **Capacity override**: a one-off adjustment of capacity for a specific date and time range (e.g., someone called in sick → 1; reinforcement → 3; closed → 0). Takes precedence over the default rule.
- **Appointment (booking)**: a patient's appointment request. Relevant attributes: patient name and phone, routine appointment type, start and end, status (held/confirmed/...), expiry deadline (while held), reference to the clinic-calendar event, origin (agent or human), and timestamps.
- **Temporary hold**: an appointment's initial state — it holds a slot's seat, counts against capacity, and expires on its own if not confirmed in time.
- **Available slot**: a derived (non-persisted) concept — a time window whose free capacity is greater than zero, respecting business hours and the type's duration. It is the only legitimate source of slots offered to the patient.
- **Audit trail**: an append-only record of every write operation (affected entity, action, actor, payload, and timestamp), for traceability and compliance.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of routine bookings created by the agent are written to the clinic calendar with no human intervention.
- **SC-002**: Zero overbooking — for any slot, the total of holds and confirmations never exceeds the defined capacity, including when N patients confirm the same slot simultaneously (at most the capacity succeeds; the rest receive alternatives).
- **SC-003**: When capacity exists, a patient completes a routine booking (from first request to confirmation) in under 3 minutes and without needing to talk to a human.
- **SC-004**: 100% of out-of-routine-scope requests are escalated to reception with no appointment or hold created.
- **SC-005**: 100% of write operations have a corresponding record in the audit trail.
- **SC-006**: 100% of slots offered to the patient are actually bookable at the moment they are offered (none outside business hours, none already full).
- **SC-007**: 100% of unconfirmed temporary holds are released automatically on expiry, returning the capacity (no seat stays stuck).
- **SC-008**: No request is lost for arriving outside business hours — 100% of requests received at any time result in a booking or an escalation.

## Assumptions

- **Scope of this spec**: it covers only User Story 1 of the [SPEC.md](../../SPEC.md) (book a routine appointment). The confirmation/reminder loop (US2) and reschedule/cancel (US3) are out of scope here and will get dedicated specs.
- **Build sequence**: the booking foundation (availability, hold, confirmation) is built and tested deterministically and independently, before and separately from the language layer (request interpretation) and the external channels (messaging and calendar). Every slot decision and every write is deterministic; the language layer only drives the conversation and never writes nor invents slots. Aligned with the constitution (Test-First; The LLM Never Writes) and the SPEC.md build order.
- **Pooled capacity model**: the patient does not choose a professional; they are served by whoever is free. Availability is a seat counter. The `assigned` mode (professional choice) is out of scope.
- **Routine appointment types**: evaluation, cleaning, follow-up, and consultation, per the SPEC.md IN scope. In the MVP all types share a uniform 30-minute duration on a 30-minute grid; per-type durations are deferred.
- **Initial capacity**: may be fixed (hardcoded) for the demo; dynamic configuration comes in a later phase.
- **Source of truth**: the clinic calendar (Google Calendar) is the source of truth for confirmed events; internal state holds capacity, holds, and sync state.
- **Patient identification**: by WhatsApp phone number; the name is collected in conversation.
- **Time zone**: the clinic's (assumed America/Sao_Paulo) for all offered and written slots.
- **Temporary hold deadline (TTL)**: 10 minutes.
- **Booking horizon**: minimum lead time of 2 hours; slots searched up to 30 days ahead.
- **Full-calendar policy**: if no slot exists within the horizon, the request is escalated to reception (consistent with "Escalate When in Doubt").
- **Channel**: WhatsApp is the inbound and outbound channel; the booking logic is independent of the specific channel.
