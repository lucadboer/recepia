-- Per-phone conversation state for the orchestrator (one live conversation per patient).
-- Retention/purge policy is DEFERRED — NEEDS-USER (LGPD finalidade/retenção).

CREATE TABLE conversation_state (
  phone      text        PRIMARY KEY,
  state      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
