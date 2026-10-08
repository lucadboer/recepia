# Data Model: Appointment Reminders and Attendance Confirmation

## booking (migration 012)
| Column | Type | Rule |
|---|---|---|
| `reminder_sent_at` | `timestamptz NULL` | set once, in the transaction that queues the reminder |
| `unconfirmed_notice_at` | `timestamptz NULL` | set once, in the transaction that queues reception's notice |

Index: `(start_ts) WHERE status = 'confirmed'` (both jobs scan confirmed bookings by start).
Transition used: `confirmed → patient_confirmed` (attendance confirmed: fast path or `confirm_attendance`).

## outbox_message (migration 012)
- `kind` CHECK += `appointment_reminder`.
- `template jsonb NULL` = `{ "name": string, "language": string, "params": string[] }`, passed to `MessagingPort.sendMessage`.
- Dedupe keys: `appointment_reminder:<bookingId>`, `attendance_confirmation:<bookingId>` (kind `booking_confirmation`), `unconfirmed:<bookingId>` (kind `reception_notice`).

## audit_log (new actions)
| Action | Entity / id | Payload |
|---|---|---|
| `reminder_enqueued` | booking | `{ start, outboxId, template }` (template name only) |
| `attendance_confirmed` | booking | `{ via: "fast_path" \| "model", outboxId, promptVersion? }` |
| `unconfirmed_notified` | booking | `{ start, outboxId }` |
