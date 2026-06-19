# recepia

Autonomous routine **dental appointment booking** over WhatsApp. The agent books routine
appointments on its own (writing to Google Calendar) and escalates anything out of scope to
reception. Built with Spec Driven Development (GitHub Spec Kit).

This repository currently contains **feature 001 — the deterministic booking foundation**
(User Story 1): real availability by pooled capacity, atomic holds with no overbooking,
confirmation that writes one calendar event, and escalation. **No LLM in this slice** — only
the deterministic tools write. Google Calendar and WhatsApp sit behind ports with in-memory
fakes.

- Spec: [specs/001-autonomous-routine-booking/spec.md](specs/001-autonomous-routine-booking/spec.md)
- Plan & contracts: [specs/001-autonomous-routine-booking/plan.md](specs/001-autonomous-routine-booking/plan.md)
- Run/validation guide: [specs/001-autonomous-routine-booking/quickstart.md](specs/001-autonomous-routine-booking/quickstart.md)
- Contributing & dependency policy: [CONTRIBUTING.md](CONTRIBUTING.md)

## Quick start

```bash
corepack enable            # use the pinned pnpm
pnpm install
pnpm db:up                 # Postgres via Docker (recepia-pg on localhost:5434)
pnpm migrate
pnpm seed                  # demo capacity: Mon–Fri 09:00–18:00, capacity 2
pnpm test                  # unit + integration + concurrency
```

## Tooling

TypeScript on Node 20+, **pnpm** (Corepack-pinned), **Vitest**, PostgreSQL via `pg`. TS scripts
run with **tsx**. Dependencies are kept at their latest audited versions — see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Key guarantees (tested)

- **No overbooking** under concurrent holds (per-slot advisory lock) — `tests/concurrency/`.
- **No confirmation without a written calendar event**; on failure: retry → escalate → release.
- Every write is recorded in an **append-only** `audit_log`.
- All patient-facing messages are in **Portuguese**.
