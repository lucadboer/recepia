-- Transactional outbox for patient/reception messages (002 Phase 11, FR-214).
-- A row is written in the SAME transaction as the domain write it announces
-- (booking_confirmed, escalated) and delivered by jobs/dispatch-outbox.ts with
-- retries; delivery is at-least-once. dedupe_key dedupes enqueue, not delivery.

CREATE TABLE outbox_message (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text        NOT NULL CHECK (kind IN ('booking_confirmation', 'escalation')),
  to_phone        text        NOT NULL,
  body            text        NOT NULL,
  dedupe_key      text        UNIQUE,
  status          text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts        integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);

CREATE INDEX outbox_message_due_idx ON outbox_message (next_attempt_at) WHERE status = 'pending';
