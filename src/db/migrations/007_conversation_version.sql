-- Optimistic concurrency for per-phone conversation state (002 Phase 11, T240).
-- DbConversationStore.save is a compare-and-swap on this column: a stale save
-- (another turn persisted first) fails with ConversationConflictError instead of
-- silently overwriting the newer state (lost update).

ALTER TABLE conversation_state ADD COLUMN version integer NOT NULL DEFAULT 0;
