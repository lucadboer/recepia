-- LGPD opt-in/opt-out ledger. Append-style: the latest row per phone wins, so
-- opt-out is reversible and auditable. Each change also appends an audit_log row.

CREATE TABLE patient_consent (
  seq        bigserial PRIMARY KEY,
  phone      text        NOT NULL,
  state      text        NOT NULL CHECK (state IN ('opted_in', 'opted_out')),
  source     text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX patient_consent_phone_idx ON patient_consent (phone, seq DESC);
