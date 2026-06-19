-- Feature 001 — deterministic booking foundation.
-- Postgres 16: gen_random_uuid() is built in.

CREATE TABLE capacity_rule (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  weekday    smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0 = Sunday
  start_time time     NOT NULL,
  end_time   time     NOT NULL,
  capacity   smallint NOT NULL CHECK (capacity >= 0),
  CHECK (end_time > start_time)
);

CREATE TABLE capacity_override (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date       date     NOT NULL,
  start_time time     NOT NULL,
  end_time   time     NOT NULL,
  capacity   smallint NOT NULL CHECK (capacity >= 0),
  CHECK (end_time > start_time)
);

CREATE TABLE booking (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_name     text,
  patient_phone    text        NOT NULL,
  appointment_type text        NOT NULL,
  start_ts         timestamptz NOT NULL,
  end_ts           timestamptz NOT NULL,
  status           text        NOT NULL
    CHECK (status IN ('held','confirmed','patient_confirmed','cancelled','done','expired')),
  expires_at       timestamptz,
  google_event_id  text,
  attended_by      text,
  created_via      text        NOT NULL CHECK (created_via IN ('ai','human')),
  consent_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Invariant: expires_at is set iff the booking is still held.
  CHECK ((status = 'held') = (expires_at IS NOT NULL))
);

-- Fast per-slot counting for availability.
CREATE INDEX booking_slot_status_idx ON booking (start_ts, status);
-- Active-hold scans (sweep + counting).
CREATE INDEX booking_held_idx ON booking (start_ts) WHERE status = 'held';
-- Hold idempotency: at most one active hold per patient per slot.
CREATE UNIQUE INDEX booking_active_hold_uq ON booking (patient_phone, start_ts) WHERE status = 'held';

CREATE TABLE audit_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity     text        NOT NULL,
  entity_id  uuid,
  action     text        NOT NULL,
  actor      text        NOT NULL,
  payload    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
