-- 008 durable inbound pipeline. Every verified patient message is stored here BEFORE the webhook
-- acknowledges it; an in-process worker claims rows FIFO per phone with a lease (crash recovery)
-- and hands them to the orchestrator. The unique key makes a redelivery a no-op.

CREATE TABLE inbound_message (
  id                  bigserial   PRIMARY KEY,
  provider            text        NOT NULL CHECK (provider IN ('evolution', 'cloud')),
  provider_message_id text        NOT NULL,
  phone               text        NOT NULL,
  body                text,
  received_at         timestamptz NOT NULL,
  status              text        NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'processing', 'done', 'dead', 'dropped')),
  attempts            integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at     timestamptz NOT NULL,
  locked_by           text,
  locked_until        timestamptz,
  last_error          text,
  trace_context       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  processed_at        timestamptz,
  UNIQUE (provider, provider_message_id),
  CHECK ((status = 'processing') = (locked_until IS NOT NULL))
);

-- The claim's per-phone FIFO / one-in-flight condition and the due scan.
CREATE INDEX inbound_message_phone_open_idx ON inbound_message (phone, id)
  WHERE status IN ('pending', 'processing');
CREATE INDEX inbound_message_due_idx ON inbound_message (next_attempt_at)
  WHERE status = 'pending';

-- Replay guard (found by the chaos test): a reclaimed message whose turn already committed a final
-- write is recognised by the inbound message id stamped on that write's audit row.
CREATE INDEX audit_log_inbound_message_idx ON audit_log ((payload->>'inboundMessageId'))
  WHERE payload ? 'inboundMessageId';

-- Review (fencing): a turn that lost its message after writing a hold's calendar event leaves the
-- hold and the event to the new holder, who may confirm that same hold (the event is idempotent by
-- hold id). It only flags the hold; the hold sweep removes the event if the hold ends unconfirmed.
ALTER TABLE booking ADD COLUMN event_cleanup_pending boolean NOT NULL DEFAULT false;
CREATE INDEX booking_event_cleanup_idx ON booking (id) WHERE event_cleanup_pending;
