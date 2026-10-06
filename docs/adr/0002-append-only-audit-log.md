# ADR 0002 — Append-only audit_log enforced by triggers

- Status: accepted (feature 001, 2026-06)

## Context
Constitution principle V requires every write to leave an audit trail (LGPD traceability). An
application-level convention is easy to break; revoking privileges does not cover the app's own
role.

## Decision
`audit_log` rows are inserted in the **same transaction** as the domain write they describe
(`appendAudit(client, …)` takes the transaction client, never the pool). Database triggers reject
`UPDATE`, `DELETE` and `TRUNCATE` on the table, so even the application role cannot rewrite history.
Tests reset the table by temporarily disabling user triggers as the table owner.

## Consequences
- An audited write cannot be committed without its audit row, and a failed write leaves no row.
- Outbox rows are treated as delivery plumbing, not domain writes: the audited write is
  `booking_confirmed` / `escalated` (payload carries the `outboxId`); dead-letter and cancellation
  get their own audit actions (`outbox_dead_letter`, `outbox_cancelled`).
- The table only grows; retention is a product decision (purge job planned with feature 005).
