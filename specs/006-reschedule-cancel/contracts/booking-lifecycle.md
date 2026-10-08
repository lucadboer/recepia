# Contract: Booking Lifecycle Tools (find, cancel, reschedule)

Deterministic writers added to the 001 tool set. Format per the POS reference: **API + Guarantees + Required Tests** (tests written before the implementation, constitution I). The model reaches them only through the registry (`src/agent/tool-registry.ts`); the phone is always the conversation's.

```ts
type UpcomingBooking = { bookingId: string; start: Date; end: Date; type: AppointmentType; status: 'confirmed' | 'patient_confirmed' };
type FindResult = { kind: 'found'; booking: UpcomingBooking } | { kind: 'none' } | { kind: 'multiple'; count: number };
type CancelOutcome = 'cancelled' | 'already_cancelled';
type RescheduleOutcome = 'rescheduled' | 'already_rescheduled';
```

---

## `find_my_booking(phone) -> FindResult`

**Guarantees**
- Only bookings of `phone` with status `confirmed | patient_confirmed` and `start > now`.
- Read-only. In the registry: `found` → recorded in `surfacedBookings` with the current turn; `none` / `multiple` → `escalate_to_human` (`booking_not_found` / `multiple_bookings`) is called by code and the conversation is handed off.

**Required Tests**
- One upcoming booking → found; a past, cancelled, expired or held booking is ignored; another phone's booking is never returned.
- Two upcoming → `multiple`; none → `none`; the registry escalates for both and writes nothing else.

---

## `cancel_booking(bookingId, phone) -> { booking, outcome }`

**Guarantees**
- One transaction: lock the row, require owner = `phone`, status `confirmed | patient_confirmed`, `start > now`; set `cancelled` + `cancelled_at`; enqueue `booking_cancellation:<id>`; when `start − now < 24 h` enqueue `late_change:<id>` for reception; audit `booking_cancelled` (prompt version for model-driven calls).
- Then delete the calendar event (retry). Persistent failure → audit `calendar_delete_failed` + reception notice `calendar_cleanup:<id>`; the booking stays cancelled.
- Already cancelled by this patient → `already_cancelled`, no write, no message.
- Errors: `BookingNotFoundError` (unknown id or another phone — indistinguishable to the caller), `BookingNotChangeableError` (past / not active).

**Required Tests**
- Capacity returns: the slot is offered again by `getAvailability` right after.
- Idempotent: a second call writes nothing and enqueues nothing.
- Another phone's booking → `BookingNotFoundError`, zero writes.
- Past booking → `BookingNotChangeableError`.
- Late (< 24 h) → reception notice in the same transaction; not late → none.
- Failure inside the transaction (`interceptingPool`) → nothing changed, nothing enqueued.
- Calendar delete keeps failing → booking cancelled, `calendar_delete_failed` audited, cleanup notice enqueued.

---

## `reschedule_booking(bookingId, holdId, phone) -> { booking: newBooking, previous, outcome }`

**Guarantees**
- Validates: old booking owned by `phone`, active, upcoming; hold owned by `phone`, `held`, not expired, same appointment type, different start.
- Idempotent: if the hold is already confirmed with `rescheduled_from = bookingId` → `already_rescheduled`.
- Creates the new calendar event first (idempotent by the new booking id, retry). Failure → hold released (`hold_released`), escalation, old booking untouched.
- One transaction: lock the old row; confirm the hold with `rescheduled_from`, the old booking's patient name and `consent_at`; cancel the old row; enqueue `booking_confirmation:<new>` (rescheduled wording) and, when late, `late_change:<old>`; audit `booking_rescheduled` (new) and `booking_cancelled {reason: "rescheduled"}` (old).
- Transaction failure / lost race → re-read: identical success already committed → return it; otherwise compensate the new event (delete + `calendar_orphan_compensated` + escalation).
- After commit: delete the old event; persistent failure handled as in cancel.
- At most one successful reschedule per booking (unique `rescheduled_from`).

**Required Tests**
- Old seat freed and new seat occupied; new event created, old event deleted; one patient message.
- Calendar create fails → old booking intact, hold released, escalation.
- Hold expired / swept before the transaction → old booking intact, orphan event compensated.
- Concurrent cancel wins → reschedule compensates its event; one final state.
- Idempotent repeat → no new writes.
- Same start, different type, foreign hold, foreign booking → refused, zero writes.
- Late → reception notice.

---

## Registry gates (in addition to 002's `unknown_tool`, `not_offered`, `foreign_hold`, `invalid_args`)

| Gate | Applies to | Refuses when |
|---|---|---|
| `not_surfaced` | cancel, reschedule | `booking_id` was not returned by `find_my_booking` in this conversation |
| `confirmation_required` | cancel, reschedule | the booking (or the reschedule's hold) was surfaced/created in the current inbound turn |
| `foreign_hold` | reschedule | `hold_id` was not created in this conversation |
| `consent` (orchestrator) | reschedule | no recorded opt-in |

**Required Tests**: each gate refuses with zero writes and the right `rejectedBy`; a cancel in the turn after `find_my_booking` passes; a reschedule passes only when both the booking and the hold are from earlier turns.

---

## Concurrency (required, `tests/concurrency/booking-lifecycle.concurrency.test.ts`)
- 10 concurrent cancels of one booking → exactly one `booking_cancelled` audit and one cancellation message.
- Cancel × reschedule of the same booking → exactly one wins; calendar events = active bookings.
- 16 concurrent holds on a time freed by a cancel (capacity 1) → exactly 1 hold.
- Several reschedules into one contested time (capacity 1) → at most one succeeds; never over capacity.
