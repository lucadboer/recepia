-- 006 reschedule-cancel (SPEC.md US3).
-- cancelled_at: when the patient (or a reschedule) cancelled the booking; tied to the status so a
-- cancelled row always says when, and no other row claims a cancellation time.
-- rescheduled_from: the booking this one replaced. The partial unique index is the STRUCTURAL
-- guarantee that at most one reschedule of a booking can ever succeed, even under races.

ALTER TABLE booking ADD COLUMN cancelled_at timestamptz;
UPDATE booking SET cancelled_at = updated_at WHERE status = 'cancelled';
ALTER TABLE booking
  ADD CONSTRAINT booking_cancelled_at_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL));

ALTER TABLE booking ADD COLUMN rescheduled_from uuid REFERENCES booking (id);
CREATE UNIQUE INDEX booking_rescheduled_from_uq
  ON booking (rescheduled_from)
  WHERE rescheduled_from IS NOT NULL;

-- find_my_booking: the patient's upcoming active bookings.
CREATE INDEX booking_patient_upcoming_idx
  ON booking (patient_phone, start_ts)
  WHERE status IN ('confirmed', 'patient_confirmed');

-- New patient/reception messages committed with the change that causes them.
ALTER TABLE outbox_message DROP CONSTRAINT outbox_message_kind_check;
ALTER TABLE outbox_message
  ADD CONSTRAINT outbox_message_kind_check
  CHECK (kind IN ('booking_confirmation', 'escalation', 'booking_cancellation', 'reception_notice'));
