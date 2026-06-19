-- Make the no-overbooking guarantee STRUCTURAL (DB-enforced), not just behavioral.
-- Each occupying booking holds a distinct seat in [0, capacity) for its slot; a
-- partial unique index forbids two active bookings on the same (slot, seat).

ALTER TABLE booking ADD COLUMN seat smallint NOT NULL DEFAULT 0 CHECK (seat >= 0);
ALTER TABLE booking ALTER COLUMN seat DROP DEFAULT;

-- States that occupy the slot are everything except the terminal free states.
CREATE UNIQUE INDEX booking_slot_seat_uq
  ON booking (start_ts, seat)
  WHERE status NOT IN ('cancelled', 'expired');
