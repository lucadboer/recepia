-- 002 Phase 11 review follow-ups.
-- conversation_phone: the patient the message is ABOUT (recipient may be reception), so the
-- orchestrator can flush exactly one conversation's rows inside a turn.
-- status 'cancelled': pending patient notifications are cancelled on opt-out (LGPD) instead of
-- being delivered after the patient was told no more messages would come.

ALTER TABLE outbox_message ADD COLUMN conversation_phone text;
CREATE INDEX outbox_message_conversation_idx ON outbox_message (conversation_phone) WHERE status = 'pending';

ALTER TABLE outbox_message DROP CONSTRAINT outbox_message_status_check;
ALTER TABLE outbox_message
  ADD CONSTRAINT outbox_message_status_check CHECK (status IN ('pending', 'sent', 'failed', 'cancelled'));
