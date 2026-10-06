# ADR 0001 — Per-slot advisory lock + seat model instead of SERIALIZABLE

- Status: accepted (feature 001, 2026-06)
- Deciders: project owner

## Context
`hold_slot` must never let `held + confirmed` exceed a slot's capacity under concurrent requests
(constitution, principle I). Candidates: `SERIALIZABLE` isolation with retry loops, a `SELECT …
FOR UPDATE` on a per-slot row, or a Postgres advisory lock keyed by the slot.

## Decision
Take `pg_advisory_xact_lock(hashtext(slot_start))` at the start of the hold transaction, reclaim
expired holds for that slot, then pick the first free seat in `[0, capacity)` and insert the hold.
A partial unique index on `(start_ts, seat)` for active bookings is the structural backstop: two
writers can never occupy the same seat even if a lock were bypassed.

## Consequences
- No serialization failures to retry; writers for the same slot queue briefly, different slots do
  not contend.
- The cap `seat < capacity` is enforced by the single writer (`holdSlot`), not by the index; a
  direct writer could exceed it. Accepted for the MVP and documented in the code; a structural cap
  arrives with the resource-based model of feature 003.
- Proven by `tests/concurrency/hold-slot.concurrency.test.ts` (16 parallel holds on capacity 2 →
  exactly 2 succeed), which is a mandatory CI gate.
