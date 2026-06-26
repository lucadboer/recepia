-- Seat model for no-overbooking. The partial unique index below is the STRUCTURAL
-- guarantee: no two active bookings may share the same (slot, seat). It does NOT
-- enforce seat < capacity — holdSlot (the sole writer) assigns seats in [0, capacity)
-- under an advisory lock, and that is what caps a slot at its capacity. A true
-- per-slot/per-resource structural cap arrives with the 003 resource-based model.

ALTER TABLE booking ADD COLUMN seat smallint NOT NULL DEFAULT 0 CHECK (seat >= 0);
ALTER TABLE booking ALTER COLUMN seat DROP DEFAULT;

-- States that occupy the slot are everything except the terminal free states.
CREATE UNIQUE INDEX booking_slot_seat_uq
  ON booking (start_ts, seat)
  WHERE status NOT IN ('cancelled', 'expired');
