-- 007 appointment-reminders (SPEC.md US2).
-- reminder_sent_at / unconfirmed_notice_at: set once, in the transaction that queues the reminder
-- (or reception's notice) through the outbox — the jobs' idempotency key together with the
-- outbox dedupe key.

ALTER TABLE booking ADD COLUMN reminder_sent_at timestamptz;
ALTER TABLE booking ADD COLUMN unconfirmed_notice_at timestamptz;

-- Both jobs scan clinic-confirmed bookings by start.
CREATE INDEX booking_confirmed_start_idx ON booking (start_ts) WHERE status = 'confirmed';

ALTER TABLE outbox_message DROP CONSTRAINT outbox_message_kind_check;
ALTER TABLE outbox_message
  ADD CONSTRAINT outbox_message_kind_check
  CHECK (kind IN ('booking_confirmation', 'escalation', 'booking_cancellation', 'reception_notice',
                  'appointment_reminder'));

-- Official WhatsApp channel: a business-initiated message must be an approved template.
-- { "name": text, "language": text, "params": text[] } — NULL for plain-text messages.
ALTER TABLE outbox_message ADD COLUMN template jsonb;
