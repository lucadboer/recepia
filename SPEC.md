# SPEC — AI dental receptionist (MVP)

> Product spec for the MVP: the input every feature spec under `specs/` was generated from with
> `/speckit.specify`. Non-negotiable principles live in the
> [constitution](.specify/memory/constitution.md). Tool contracts follow the "API + Guarantees +
> Required tests" format.

## Goal

One sellable feature: **autonomous booking of routine appointments over WhatsApp**, with real
writes to Google Calendar and automatic confirmation. Everything that is not routine is escalated to
the reception. No-show reduction (confirmation/reminder) comes with the booking loop and is the
pilot's ROI metric.

## Delivery status

Every user story below is implemented; each links to the feature spec that delivered it.

| User story | Delivered by | Refinements decided during delivery |
| --- | --- | --- |
| US1 — book a routine appointment | [001](specs/001-autonomous-routine-booking/spec.md) (deterministic tools), [002](specs/002-conversational-orchestration/spec.md) (LLM orchestration) | — |
| US2 — confirm the appointment / reduce no-shows | [007](specs/007-appointment-reminders/spec.md) | The reminder goes out ~24 h before (not 24–48 h). No reply: the booking stays and reception is notified a few hours before. |
| US3 — reschedule and cancel | [006](specs/006-reschedule-cancel/spec.md) | `reschedule_booking(booking_id, hold_id)`: the new time comes from `get_availability` → `hold_slot`, never from the model. |

Not built yet (each needs its own spec): bidirectional Calendar sync (watch API / sync tokens), the
ROI dashboard, capacity configuration by the clinic, and a clinic-facing override view (today
reception hands a conversation back with a CLI command).

---

## User scenarios & testing

Prioritised user stories. Each one is independently testable and delivers value on its own.

### User Story 1 — Book a routine appointment (P1)

A patient messages the clinic on WhatsApp at any time and books a routine appointment on their own;
the event shows up in the clinic's Google Calendar.

**Why P1**: it is the sellable core and the demo. On its own it already justifies the product
(after-hours capture, and it frees the reception).

**Independent test**: send a message asking for a time and check that the event is written to the
Calendar with no human involvement and no overbooking.

**Acceptance scenarios**:
1. **Given** free capacity at a time, **when** the patient asks to book a cleaning and confirms an
   offered time, **then** the booking is written to the Calendar and the patient gets a confirmation.
2. **Given** two patients going for the same time at once, **when** both confirm, **then** only one
   is written and the other gets alternative times (no overbooking).
3. **Given** no capacity in the requested period, **when** the patient insists, **then** the agent
   offers the next genuinely free times.
4. **Given** a request that is not routine (e.g. Invisalign), **when** the patient sends it,
   **then** the agent escalates to the reception without trying to book.

### User Story 2 — Confirm the appointment / reduce no-shows (P2)

Before the appointment, the agent asks for confirmation automatically and frees the slot if the
patient cancels.

**Why P2**: it produces the no-show reduction number that supports the ROI. It depends on the
booking loop existing.

**Independent test**: create a booking, run the reminder job and check the message is sent and that
YES / RESCHEDULE replies are processed.

**Acceptance scenarios**:
1. **Given** a confirmed booking 24–48 h ahead, **when** the job runs, **then** the patient gets a
   confirmation request.
2. **Given** the confirmation request, **when** the patient replies "SIM", **then** the status
   becomes `patient_confirmed`.
3. **Given** the confirmation request, **when** the patient asks to reschedule, **then** the slot is
   freed and the reschedule flow starts.

### User Story 3 — Reschedule and cancel (P3)

The patient reschedules or cancels over WhatsApp; capacity is freed correctly.

**Why P3**: it completes the booking lifecycle, but the demo and the ROI already work without it.

**Acceptance scenarios**:
1. **Given** an existing booking of the patient, **when** they ask to reschedule, **then** the old
   one is freed and the new one is written atomically.
2. **Given** an existing booking, **when** they cancel, **then** the capacity becomes available
   again.
3. **Given** several bookings or an ambiguous case, **when** they ask for a change, **then** the
   agent escalates to the reception.

---

## Scope (IN)

Receive messages at any time; classify intent; book routine appointments (assessment, cleaning,
follow-up, consultation); check real availability, reserve, confirm and write to the Calendar;
confirm/remind before the appointment; escalate anything out of scope; audit every write.

## Out of scope (do not build without a dedicated spec)

Specialised procedures (Invisalign, orthodontics, implants, surgery → **always escalate**);
multi-session treatment plans; per-dentist calendars / choosing the professional
(`scheduling_mode: assigned`); routing by speciality or chair; schedule optimisation; integration
with dental practice software; payments and billing.

## Capacity model (pooled)

The patient does not choose a dentist; whoever is free sees them. Availability is a **capacity
counter**, not resource matching.

```
free(T, duration) = capacity(T) − bookings(T) − active_holds(T) > 0
capacity(T)       = override(T) ?? default_rule(T)   // bounded by the number of chairs
```

- `default_rule`: the normal schedule (e.g. Mon–Fri 09–18, capacity 2).
- `override`: an adjustment for one day (someone is out → 1; extra staff → 3). **Required in the
  MVP.**
- In the first demo capacity could be hard-coded; configuration comes later.

## Data model (key entities)

```
capacity_rule      weekday, start_time, end_time, capacity
capacity_override  date, start_time, end_time, capacity
booking            id, patient_name, patient_phone, appointment_type,
                   start, end, status (held|confirmed|patient_confirmed|cancelled|done),
                   expires_at (TTL for held), google_event_id,
                   attended_by (nullable), created_via (ai|human), created_at, updated_at
audit_log          id, entity, entity_id, action, actor, payload, created_at  (append-only)
```

Source of truth: Google Calendar = confirmed events; Postgres = capacity + holds + sync state.
Ingest the Calendar through the watch API / sync tokens to learn about bookings made by hand.

## Tool contracts

The deterministic layer. The LLM **never** writes directly — it only calls these functions. Build
and test them in isolation, without the LLM. Format: API + Guarantees + Required tests (written
BEFORE the implementation).

### `get_availability(period, appointment_type) -> Slot[]`
- **Guarantees**: the only source of times; returns only slots that respect capacity, opening hours
  and the type's duration; deterministic for the same state.
- **Tests**: returns nothing when capacity is used up; honours `capacity_override`; never returns a
  slot outside opening hours.

### `hold_slot(slot) -> Hold`
- **Guarantees**: an **atomic** reservation with a TTL (advisory lock on the time → recheck
  `used < capacity` → insert); idempotent; expires on its own.
- **Tests**: **N concurrent holds on the same time never exceed the capacity** (mandatory
  concurrency test); an expired hold frees the slot; a second hold by the same patient does not
  duplicate.

### `confirm_booking(hold_id, patient) -> Booking`
- **Guarantees**: idempotent; writes to the Calendar through `CalendarPort`; sends the confirmation
  through `MessagingPort`; recorded in `audit_log`.
- **Tests**: confirming a valid hold writes exactly one event; confirming an expired hold fails with
  a handleable error; a repeated call does not duplicate.

### `reschedule_booking(booking_id, new_slot) -> Booking` / `cancel_booking(booking_id) -> void`
- **Guarantees**: free the old time's capacity atomically; audited.
- **Tests**: rescheduling moves the booking without leaving the old time taken; cancelling returns
  the capacity.

### `escalate_to_human(reason, context) -> void`
- **Guarantees**: notifies the reception; ends the autonomous attempt; audited.

## Confirmation / reminder loop (outbound)

A job runs 24–48 h before. For every `confirmed` booking it sends a confirmation request. `SIM` →
`patient_confirmed`. Reschedule / no → free the capacity + reschedule flow. No reply → a policy
agreed with the clinic.

## Guardrails (non-negotiable)

The LLM never writes directly; `get_availability` is the only source of times; explicit
confirmation before any commit; when in doubt → escalate; everything in `audit_log`; a panic button
/ clinic view to override.

## LGPD (health data is sensitive data)

Clear opt-in, easy opt-out, minimal collection, `audit_log` of every operation, no marketing without
consent.

## WhatsApp layer (adapter)

A `MessagingPort` (`sendMessage`, `onMessage`) with two implementations: **Evolution API**
(dev/demo) and the **official Cloud API** (pilot with real patients). Build against the interface.

## Stack

TS/Node; PostgreSQL; Vitest; Claude through the API with tool use (the orchestrator, added only at
the LLM stage); a queue/cron for the reminder; Google Calendar API + watch API.

## Build order (vertical slices)

1. Deterministic layer + tests (**no LLM**, integrations stubbed). Guarantee no overbooking.
2. Slice 1 (demo): book a routine appointment → write to the Calendar → confirm on WhatsApp, with
   escalation as the safety net. Hard-coded capacity.
3. Robust escalation + FAQ.
4. Reschedule / cancel.
5. Reminder loop + ROI dashboard.
6. Capacity configuration + bidirectional Calendar sync.

## Pilot acceptance criteria

No-show rate before vs. after (conservative target: ~1/3 reduction); number of bookings made 100 %
by the AI; number of after-hours captures; average response time; number of escalations and their
reasons.
