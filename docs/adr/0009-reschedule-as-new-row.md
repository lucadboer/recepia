# ADR 0009 — Reschedule as a new booking row; cancel database-first; calendar compensation

- Status: accepted (feature 006, 2026-10-08)

## Context
Patients can now cancel or move a routine appointment over WhatsApp (SPEC.md US3). The calendar
port only creates (idempotently, by booking id) and deletes events; capacity lives in Postgres
behind one seat allocator (`holdSlot`, ADR 0001). A reschedule must never leave the patient with two
appointments or none, and two concurrent reschedules of the same appointment must not both win.

## Decision
- **Reschedule creates a new booking.** The new time is a hold made through the normal
  `get_availability → hold_slot` path (so the "offered in this conversation" gate, the per-slot
  lock and the booking window apply). `reschedule_booking(booking_id, hold_id)` writes the new
  calendar event first, then in **one transaction** locks the old row, confirms the hold with
  `rescheduled_from = old.id`, cancels the old row, commits the patient message (and a reception
  notice when the change is less than 24 h ahead) and audits both rows. Then it deletes the old
  event. `UNIQUE (rescheduled_from)` makes a second successful reschedule impossible.
- **Cancel is database-first.** One transaction cancels (seat free at once), commits the messages
  and audits; the event is deleted afterwards.
- **Postgres stays the source of truth.** A new event whose transaction cannot commit is
  compensated (deleted, audited, handed off) unless an identical call already won. An old event
  that cannot be deleted becomes `calendar_delete_failed` plus a reception notice to remove it by
  hand — the change is never undone because of the calendar.
- **Explicit confirmation is structural.** The registry refuses a cancel/reschedule on a booking
  not shown by `find_my_booking` in this conversation (`not_surfaced`) or shown in the current
  inbound turn (`confirmation_required`; for a reschedule also the hold).

## Consequences
- History is kept: the old row stays `cancelled` with `cancelled_at`; the new row points to it.
- No `CalendarPort.updateEvent` and no second seat allocator.
- One extra round trip when a patient asks to cancel in the first message — the price of the
  structural confirmation.
- Bookings that exist only in the calendar are invisible to `find_my_booking` and go to reception.

## Alternatives considered
- Update `start_ts` in place: needs `updateEvent`, re-implements seat allocation, loses history.
- Delete the old event before committing: a failure would leave a confirmed booking without an event.
- Deterministic matching of "sim" for the confirmation: brittle and duplicates what the model reads.
