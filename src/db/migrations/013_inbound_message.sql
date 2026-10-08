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
