# Contract: Reminders, Attendance Confirmation and Templates

Format: **API + Guarantees + Required Tests** (tests first, constitution I).

## `enqueueDueReminders(deps, now) -> { queued: number }`
**Guarantees**: queues one reminder per qualifying booking (confirmed, `reminder_sent_at` NULL, `now + NOTICE_LEAD < start ≤ now + REMINDER_LEAD`, `created_at ≤ start − REMINDER_LEAD`, latest consent `opted_in`); per booking: stamp + outbox (`appointment_reminder:<id>`, template when configured) + audit `reminder_enqueued`, one transaction; `FOR UPDATE SKIP LOCKED`.
**Required Tests**: timing table (inside window; > 24 h; < lead; booked late; patient_confirmed; cancelled; opted-out; never consented); idempotent re-run; two concurrent runs → one reminder; template stored when configured.

## `notifyUnconfirmed(deps, now) -> { notified: number }`
**Guarantees**: one `reception_notice` (`unconfirmed:<id>`) + stamp + audit `unconfirmed_notified` per booking still `confirmed`, reminded, not yet noticed, starting within `NOTICE_LEAD`.
**Required Tests**: notified once; not for patient_confirmed / cancelled / not reminded / already started.

## `confirmAttendance(deps, bookingId, phone, via) -> { booking, outcome: 'confirmed' | 'already_confirmed' }`
**Guarantees**: owner = phone, status `confirmed` → `patient_confirmed`, reply `attendance_confirmation:<id>` through the outbox, audit `attendance_confirmed`; one transaction; idempotent; another phone's booking → `BookingNotFoundError`; past or not active → `BookingNotChangeableError`.

## Orchestrator fast path
**Guarantees**: runs only after consent capture and only when: exactly one pending reminder for the phone, not awaiting consent, conversation not escalated, no live hold in the conversation, `isStrictAffirmative(text)`. Zero model calls; the outbox reply is the only patient message.
**Required Tests**: precedence (opt-out first; consent capture first; handed-off untouched; two pending reminders → model; "sim, mas…" → model); the pre-surfaced booking makes `confirm_attendance` allowed and keeps cancel's round trip.

## `confirm_attendance(booking_id)` (tool)
Gate: `not_surfaced`. **Required Tests**: refused for a booking not shown; allowed for the reminder's booking in the same turn.

## Messaging templates
**Guarantees**: Cloud sends `type: "template"` with body text parameters (no newlines); Evolution sends the text; Cloud parser reads `button.text` and `interactive.button_reply.title`; Cloud + reminders on + no template → `NotConfigured` at startup.
