# Implementation Plan: Autonomous Routine Appointment Booking via WhatsApp

**Branch**: `main` (feature `001-autonomous-routine-booking`) | **Date**: 2026-06-18 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-autonomous-routine-booking/spec.md`

## Summary

Build the **deterministic booking foundation** for User Story 1: a patient asks for a routine appointment, the system computes genuinely free slots from pooled capacity, holds one atomically, and on explicit confirmation writes exactly one calendar event — with **no overbooking under concurrency**. This slice is **LLM-free**: the only writers are deterministic tools (`get_availability`, `hold_slot`, `confirm_booking`, `escalate_to_human`). External integrations (Google Calendar, WhatsApp) sit behind testable ports (`CalendarPort`, `MessagingPort`, `Clock`) with in-memory fakes. The no-overbooking invariant is enforced with a per-slot Postgres advisory lock and proven by a mandatory concurrency test.

## Technical Context

**Language/Version**: TypeScript 6.x on Node 20+ (package manager: **pnpm** via Corepack; TS scripts run via **tsx**). Dependencies are installed at latest via `pnpm add` and audited (`pnpm audit`, zero HIGH/CRITICAL) — see [CONTRIBUTING.md](../../CONTRIBUTING.md).

**Primary Dependencies**: `pg` (node-postgres) for Postgres access with explicit transactions + advisory locks; Vitest as test framework. No LLM SDK, no Google/WhatsApp SDK in this slice — integrations are behind ports with fakes.

**Storage**: PostgreSQL — capacity rules/overrides, bookings/holds, append-only audit log. Google Calendar is the source of truth for confirmed events (behind `CalendarPort`; real adapter deferred).

**Testing**: Vitest. Unit (pure domain), integration (tools against real Postgres + fakes), and a **mandatory concurrency suite** (N concurrent holds on one slot never exceed capacity). Time is injected via a `Clock` port so TTL/horizon/expiry are deterministic (no real sleeps).

**Target Platform**: Linux server (headless Node service).

**Project Type**: Single backend project (deterministic domain + tools). No UI.

**Performance Goals**: Correctness-first. `get_availability` over a 30-day horizon returns < 200 ms p95 at clinic scale. The hard requirement is the concurrency invariant, not throughput.

**Constraints**: No overbooking under concurrency (invariant); deterministic given DB state; every write recorded in `audit_log` within the same transaction as the state change; booking errors are explicit and recoverable (`SlotUnavailableError`, `HoldExpiredError`, …), never silent. Patient-facing strings are pt-BR (this slice produces none directly — it exposes tools, not conversation).

**Scale/Scope**: Single clinic, pooled capacity (≤ a few chairs), low write volume. User Story 1 only; US2 (reminders) and US3 (reschedule/cancel) are out of scope.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Status | How this plan complies |
|---|---|---|
| **I. Test-First (NON-NEGOTIABLE)** | ✅ PASS | TDD for all domain logic. Tests (incl. the mandatory concurrency test proving holds never exceed capacity) are written and fail before implementation. Ports have fakes so domain/tools are tested in isolation. |
| **II. The LLM Never Writes (NON-NEGOTIABLE)** | ✅ PASS | This slice has no LLM. Only the deterministic tools write. `get_availability` is the single source of slots; no slot is ever inferred. |
| **III. Simplicity & YAGNI** | ✅ PASS | Single project; raw `pg` + SQL (no ORM); no abstraction without a real second consumer. The only ports are `CalendarPort`/`MessagingPort`/`Clock` — explicitly sanctioned by the constitution (Messaging has two real consumers: Evolution + Cloud API; Calendar/Clock isolate testable I/O). Nothing from the OUT scope is built. |
| **IV. Escalate When in Doubt (NON-NEGOTIABLE)** | ✅ PASS | `escalate_to_human` is a first-class tool. Non-routine types, ambiguity, an empty horizon, and unrecoverable calendar failures all escalate. Explicit patient confirmation is required before any commit (hold → confirm). |
| **V. Traceability & LGPD (NON-NEGOTIABLE)** | ✅ PASS | Every write appends to `audit_log` in the same transaction. Minimal data (name, phone, type); `created_via` recorded. Opt-in consent is required by FR-020 (capture flow deferred to the conversational slice, but the field is modeled). |

**Result**: No violations. Complexity Tracking left empty.

## Project Structure

### Documentation (this feature)

```text
specs/001-autonomous-routine-booking/
├── plan.md              # This file
├── research.md          # Phase 0 output — technical decisions
├── data-model.md        # Phase 1 output — entities, schema, state machine
├── quickstart.md        # Phase 1 output — run/validation guide
├── contracts/           # Phase 1 output
│   ├── booking-tools.md  # get_availability, hold_slot, confirm_booking, escalate_to_human
│   └── ports.md          # CalendarPort, MessagingPort, Clock
├── checklists/
│   └── requirements.md  # Spec quality checklist (from /speckit-specify)
└── tasks.md             # /speckit-tasks output (NOT created here)
```

### Source Code (repository root)

```text
src/
├── domain/                 # pure logic, no I/O — fully unit-tested
│   ├── time.ts                 # slot grid (30-min), horizon [now+2h, now+30d], America/Sao_Paulo
│   ├── capacity.ts             # capacity(T) = override(date,slot) ?? rule(weekday,slot)
│   ├── availability.ts         # free(T) = capacity − confirmed − activeHolds; slot enumeration
│   ├── booking.ts              # booking state machine (held → confirmed | expired)
│   └── errors.ts               # SlotUnavailableError, HoldExpiredError, OutOfScopeError, CalendarWriteError
├── tools/                  # deterministic tools the LLM will later call (no LLM here)
│   ├── get-availability.ts
│   ├── hold-slot.ts
│   ├── confirm-booking.ts
│   └── escalate-to-human.ts
├── ports/                  # interfaces only
│   ├── calendar-port.ts
│   ├── messaging-port.ts
│   └── clock.ts
├── adapters/
│   └── fakes/                  # in-memory fakes for tests & local dev
│       ├── fake-calendar.ts
│       └── fake-messaging.ts
├── db/
│   ├── pool.ts                 # pg pool
│   ├── migrations/             # SQL migrations (capacity, booking, audit_log)
│   └── repositories/           # capacity-repo, booking-repo, audit-repo
├── jobs/
│   └── expire-holds.ts         # periodic sweep: held → expired (housekeeping + audit)
└── config.ts                   # business hours, capacity defaults, TTL=10m, horizon, timezone

tests/
├── unit/                   # domain logic (capacity, availability, time, state machine)
├── integration/            # tools against real Postgres + fakes
└── concurrency/            # MANDATORY: N concurrent holds on one slot ≤ capacity
```

**Structure Decision**: Single backend project, layered. `domain/` is pure and I/O-free (fast unit tests, deterministic). `tools/` orchestrate domain + repositories + ports and are the only writers. `ports/` + `adapters/fakes/` isolate Calendar/WhatsApp/Clock so the whole slice runs and is tested without real integrations. `db/` keeps SQL explicit (the advisory-lock transaction lives here, not hidden behind an ORM). This directly serves the build order in SPEC.md (deterministic layer first) and the Test-First / LLM-Never-Writes principles.

## Complexity Tracking

> No constitution violations — section intentionally empty.
