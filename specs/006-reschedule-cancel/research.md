# Research: Reschedule and Cancel over WhatsApp

## R1 — Tool surface
- **Decision**: `find_my_booking()` (no arguments), `cancel_booking(booking_id)`, `reschedule_booking(booking_id, hold_id)`. The tool list stays static (prompt caching of the tools block is preserved).
- **Rationale**: the phone comes from the conversation, so the lookup needs no argument; returning exactly one booking — or handing off by code when there are none or several — implements SPEC.md US3-3 structurally instead of trusting the prompt. Taking a `hold_id` for the new time reuses the 002 gate "only offered slots", the advisory lock and the booking window.
- **Alternatives considered**: `reschedule_booking(booking_id, new_start)` as in SPEC.md (would need its own capacity check and lock — a second seat allocator); a `list_my_bookings` returning several (the model would have to disambiguate, which US3-3 sends to reception).

## R2 — Explicit confirmation as a structural gate
- **Decision**: `ConversationState.turnSeq` increments once per accepted inbound message. `find_my_booking` stores `{bookingId, turn}` in `surfacedBookings`; `hold_slot` stores `{holdId, turn}` in `holdSeqs`. `cancel_booking`/`reschedule_booking` are refused with `confirmation_required` when the booking (or the hold) was surfaced in the current turn.
- **Rationale**: the patient must have seen the exact appointment (and the new time) and written back before a destructive action. One extra round trip for "pode cancelar" in a first message is the price.
- **Alternatives considered**: deterministic "sim" matching (duplicates language understanding, brittle); prompt-only (not structural).

## R3 — Reschedule creates a new booking row
- **Decision**: the hold becomes the new booking (`confirmHeld(..., rescheduledFrom = old.id)`), the old row is set to `cancelled` in the same transaction. `UNIQUE (rescheduled_from) WHERE NOT NULL` makes a second successful reschedule of the same booking impossible at the database level.
- **Rationale**: `holdSlot` stays the only seat allocator; each calendar event id stays tied to one booking id (`recepia:<bookingId>`); history is kept (old row cancelled, new row linked).
- **Alternatives considered**: updating `start_ts` in place (needs `updateEvent`, a new seat allocation path and loses history).

## R4 — Calendar ordering and compensation
- **Decision**: reschedule — create the new event (retry), then one DB transaction (lock old `FOR UPDATE`, re-check active/upcoming, confirm new, cancel old, outbox, audits), then delete the old event (retry). Cancel — DB transaction first, then delete. A failed create releases the hold and hands off with the old booking untouched. A failed transaction after the event exists runs the 001 orphan compensation (delete the new event, audit `calendar_orphan_compensated`, hand off) unless an identical call already won (idempotent). A delete that keeps failing commits `calendar_delete_failed` + a `reception_notice` (dedupe `calendar_cleanup:<bookingId>`).
- **Rationale**: Postgres owns capacity (constitution, domain constraints); the calendar can lag, never the reverse. Creating before committing means a confirmed reschedule always has its event.
- **Alternatives considered**: deleting the old event first (a failure would leave a confirmed booking without an event).

## R5 — Late-change notice
- **Decision**: `isLateChange(originalStart, now) = originalStart − now < 24 h`; when true, the cancel/reschedule transaction also enqueues a `reception_notice` (dedupe `late_change:<oldBookingId>`). A permanently failed `reception_notice` is dead-lettered like an escalation (no second escalation for it).
- **Rationale**: owner decision 2026-10-08; reception can re-offer the chair.

## R6 — Consent
- **Decision**: the orchestrator's consent gate (today only `confirm_booking`) also covers `reschedule_booking`; `cancel_booking` needs none.
- **Rationale**: a reschedule writes a new booking with personal data; a cancel reduces data and must work after an opt-out.

## R7 — Evaluation and live spend
- **Decision**: case seeds gain booking `name`, `type` and status `patient_confirmed`; placeholders `$lastBookingId` (scripts) and `$ownBookingId` (matchers); `writes` gains `cancellations`, `reschedules`, `calendarDeletes`, `receptionNotices`. resched-01..03 become real flows, resched-04 (attendance) stays a limitation until 007. New adversarial cases per FR-612. Live: one labelled subset run (~18 cases × 1, cap US$ 0.40), at most one rerun (US$ 0.30).
- **Rationale**: owner budget US$ 2.50 for 006–008.
