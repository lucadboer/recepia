# ADR 0006 — Pooled capacity, not per-dentist scheduling

- Status: accepted (feature 001, 2026-06); revisited by feature 003 research

## Context
Routine appointments in a small clinic are interchangeable across chairs/professionals. Letting
patients pick a dentist multiplies the scheduling surface (specialties, individual calendars,
routing) and is explicitly out of scope for the MVP (SPEC.md "Não-escopo").

## Decision
Availability is a capacity counter per 30-minute slot: `free(T) = capacity(T) − confirmed(T) −
activeHolds(T)`, with `capacity_rule` per weekday and `capacity_override` per date (an override of
0 closes the day). Google Calendar receives one event per confirmed booking and is the source of
truth for confirmed events; Postgres owns capacity, holds and sync state.

## Consequences
- Simple, testable arithmetic; no resource matching.
- A slot blocked directly in Google Calendar is not visible to `get_availability` (known gap,
  feature 003 research §3a).
- Feature 003 proposes capacity per professional/specialty, which requires a constitution
  amendment; until then the agent escalates any request for a specific dentist.
