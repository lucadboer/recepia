-- Feature 005 (FR-504): the W3C traceparent of the turn that enqueued the message, so its
-- delivery — immediate or by the background dispatcher, retries included — is linked to that
-- turn's trace. NULL when tracing is off and for rows written before this migration.
ALTER TABLE outbox_message ADD COLUMN trace_context text;
