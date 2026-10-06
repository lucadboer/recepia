---
description: "Task list for 001-autonomous-routine-booking"
---

# Tasks: Autonomous Routine Appointment Booking via WhatsApp

**Input**: Design documents from `specs/001-autonomous-routine-booking/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/)

**Tests**: **REQUIRED** — the constitution makes Test-First NON-NEGOTIABLE and mandates a concurrency test proving holds never overbook. Test tasks are written FIRST and must FAIL before implementation. The mandatory concurrency test is **T023** (the gate).

> **Reconciled 2026-10-06**: feature 001 has been complete since 2026-06 (every file below exists and the suite is green), but the checkboxes were never updated. They are marked here from a review of the code, not from new work. T043 is superseded by the CI perf smoke (`scripts/perf-smoke.ts`, `.github/workflows/perf.yml`), which measures the full availability → hold → confirm turn p95 on every run.

**Organization**: Tasks are grouped by user story. US1 is the MVP and is independently testable on its own.

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: Can run in parallel (different files, no dependency on incomplete tasks)
- **[Story]**: US1 / US2 / US3 (Setup, Foundational, Polish carry no story label)
- All paths are relative to the repository root.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and tooling.

- [x] T001 Create the project structure per [plan.md](plan.md): `src/{domain,tools,ports,adapters/fakes,db/migrations,db/repositories,jobs}` and `tests/{unit,integration,concurrency}`
- [x] T002 Initialize the pnpm + TypeScript project: `package.json`, `tsconfig.json` (strict); install latest `pg`, `vitest`, `@biomejs/biome`, `@types/pg`, `@types/node`, `typescript`, `tsx` via `pnpm add` (latest versions, `pnpm audit` clean) — see [CONTRIBUTING.md](../../CONTRIBUTING.md)
- [x] T003 [P] Add `package.json` scripts (`migrate`, `seed`, `test:unit`, `test:integration`, `test:concurrency`, `test`) and `vitest.config.ts`
- [x] T004 [P] Configure formatter/linter in `biome.json`; add `node_modules` and `.env` to `.gitignore`
- [x] T005 [P] Add local Postgres setup `docker-compose.yml` and `.env.example` with `DATABASE_URL`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared infrastructure every user story depends on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T006 Implement `src/config.ts`: business hours (Mon–Fri 09:00–18:00, capacity 2), TTL 10 min, horizon `[now+2h, now+30d]`, timezone `America/Sao_Paulo`, routine types allowlist (`evaluation`, `cleaning`, `follow_up`, `consultation`)
- [x] T007 [P] Implement `src/domain/errors.ts`: `SlotUnavailableError`, `HoldExpiredError`, `OutOfScopeError`, `CalendarWriteError`
- [x] T008 [P] Define ports in `src/ports/clock.ts`, `src/ports/calendar-port.ts`, `src/ports/messaging-port.ts` (interfaces per [contracts/ports.md](contracts/ports.md))
- [x] T009 [P] Implement fakes in `src/adapters/fakes/fake-clock.ts`, `fake-calendar.ts` (idempotent by key, configurable failure), `fake-messaging.ts` (captures sent messages)
- [x] T010 Implement `src/db/pool.ts` (pg `Pool` from `DATABASE_URL`)
- [x] T011 Create SQL migrations in `src/db/migrations/` for `capacity_rule`, `capacity_override`, `booking`, `audit_log` per [data-model.md](data-model.md) — `booking` includes `created_via` and nullable `consent_at`; incl. index `(start_ts, status)`, partial index on held `(start_ts)`, and partial unique `(patient_phone, start_ts) WHERE status='held'`
- [x] T012 [P] Implement seed script `src/db/seed.ts` (demo capacity rule: Mon–Fri 09:00–18:00 capacity 2)
- [x] T013 [P] Implement `src/db/repositories/audit-repo.ts` (append an `audit_log` row using a provided tx client)
- [x] T014 [P] Implement `src/db/repositories/capacity-repo.ts` (load rules + overrides for a date range)
- [x] T015 [P] Implement `src/db/repositories/booking-repo.ts` (count confirmed + active holds per slot, insert hold, confirm, release/expire — all tx-aware; correctness proven by US1 T023/T024)
- [x] T016 [P] Unit test for the slot grid/horizon in `tests/unit/time.test.ts` (30-min alignment, horizon clamp `now+2h`/`now+30d`, business-hours check, `America/Sao_Paulo`) — write first, must FAIL
- [x] T017 [P] Unit test for capacity resolution in `tests/unit/capacity.test.ts` (`override ?? rule`, override `0` = closed) — write first, must FAIL
- [x] T018 Implement `src/domain/time.ts` to make T016 pass
- [x] T019 Implement `src/domain/capacity.ts` to make T017 pass
- [x] T020 [P] Integration test for `escalate_to_human` in `tests/integration/escalate.test.ts` (notifies reception via `FakeMessaging`, creates no booking, writes `escalated` audit row) — write first, must FAIL
- [x] T021 Implement `src/tools/escalate-to-human.ts` (MessagingPort + audit-repo) to make T020 pass — shared by US1/US2/US3

**Checkpoint**: Foundation ready — user stories can begin.

---

## Phase 3: User Story 1 - Book an available routine slot (Priority: P1) 🎯 MVP

**Goal**: A patient gets genuinely free slots, holds one atomically, and on explicit confirmation the system writes exactly one calendar event + a pt-BR confirmation — with no overbooking under concurrency.

**Independent Test**: Run the e2e (T026) and concurrency (T023) suites against Postgres + fakes: availability → hold → confirm produces one event + one confirmation, and N concurrent holds never exceed capacity.

### Tests for User Story 1 (write FIRST, ensure they FAIL) ⚠️

- [x] T022 [P] [US1] Availability test in `tests/integration/get-availability.test.ts`: empty when full; honors `capacity_override` (incl. 0); never returns off-hours/off-grid/`<now+2h`/`>now+30d`; an active hold reduces `free(T)`, an expired hold does not
- [x] T023 [P] [US1] **MANDATORY concurrency test** in `tests/concurrency/hold-slot.concurrency.test.ts`: N concurrent `hold_slot` on one slot with capacity C ⇒ exactly C succeed, N−C raise `SlotUnavailableError`, DB shows ≤ C active holds
- [x] T024 [P] [US1] Hold test in `tests/integration/hold-slot.test.ts`: idempotent for same `patient_phone`+slot; expired hold releases the seat (lazy + sweep, advancing `FakeClock`); full slot → `SlotUnavailableError`; `hold_created` audit row; **asserts `created_via='ai'`** (FR-016)
- [x] T025 [P] [US1] Confirm test in `tests/integration/confirm-booking.test.ts`: writes one event + one pt-BR message; expired hold → `HoldExpiredError` and writes nothing; repeat confirm is idempotent; persistent calendar failure → retry → escalate + release hold + no confirmation + `CalendarWriteError`; `booking_confirmed` audit row; **asserts `created_via='ai'` and `consent_at` stamped** (FR-016, FR-020)
- [x] T026 [P] [US1] End-to-end happy-path test in `tests/integration/booking-e2e.test.ts` (Acceptance Scenario 1: availability → hold → confirm → event + confirmation, no human)

### Implementation for User Story 1

- [x] T027 [P] [US1] Implement `src/domain/availability.ts`: `free(T) = capacity − confirmed − activeHolds`; enumerate offerable grid slots within the horizon
- [x] T028 [P] [US1] Implement `src/domain/booking.ts`: state machine `held → confirmed | expired` with guards (`held → confirmed` requires `expires_at > now` and a written event)
- [x] T029 [US1] Implement `src/tools/get-availability.ts` (uses `time` + `capacity` + `availability` + `booking-repo`) — make T022 pass
- [x] T030 [US1] Implement `src/tools/hold-slot.ts` (advisory-lock tx: `pg_advisory_xact_lock(slot)` → recheck `used < capacity` → insert `held`, `expires_at = clock.now()+10m`, `created_via='ai'` → audit; idempotency by `patient_phone`+slot) — make T023, T024 pass
- [x] T031 [US1] Implement `src/tools/confirm-booking.ts` (validate non-expired hold; `CalendarPort.createEvent` idempotent by booking id; set `google_event_id`; `status → confirmed`; stamp `consent_at`; pt-BR confirmation via `MessagingPort`; on failure retry ≤3 → `escalate_to_human` + release hold; audit in same tx) — make T025, T026 pass
- [x] T032 [US1] Implement `src/jobs/expire-holds.ts` (sweep `held → expired` past TTL + `hold_expired` audit) — assertions covered by T024

**Checkpoint**: User Story 1 is fully functional and independently testable — this is the MVP.

---

## Phase 4: User Story 2 - Real alternatives when the requested period is full (Priority: P2)

**Goal**: When the requested period has no capacity, offer the next genuinely free slots; if none exist within the horizon, escalate instead of dead-ending.

**Independent Test**: Exhaust a period's capacity, request a slot in it, and verify the next real free slots are returned (none off-hours/full); with the whole horizon full, verify escalation fires.

### Tests for User Story 2 (write FIRST, ensure they FAIL) ⚠️

- [x] T033 [P] [US2] Next-slots test in `tests/integration/alternatives.test.ts`: requested period full ⇒ returns subsequent real free slots within the horizon; none off-hours or full
- [x] T034 [P] [US2] Empty-horizon test in `tests/integration/empty-horizon-escalation.test.ts`: no free slot within 30 days ⇒ `escalate_to_human` fires, no booking created

### Implementation for User Story 2

- [x] T035 [US2] Implement "find next available slots" (search forward to the horizon when the requested period is empty) in `src/tools/get-availability.ts` — make T033 pass
- [x] T036 [US2] Wire the empty-horizon path to `escalate_to_human` in `src/tools/get-availability.ts` — make T034 pass

**Checkpoint**: User Stories 1 and 2 both work independently.

---

## Phase 5: User Story 3 - Escalate non-routine requests (Priority: P2)

**Goal**: A request whose appointment type is not routine is escalated to reception, with no booking or hold created.

**Independent Test**: Call the entry tools with a non-routine type and verify escalation fires, nothing is persisted, and an `escalated` audit row is written.

> Note: natural-language intent/urgency detection (e.g., recognizing "Invisalign" or pain in free text) is LLM-side and **deferred to the conversational slice**. This slice enforces the deterministic routine-type allowlist guard.

### Tests for User Story 3 (write FIRST, ensure they FAIL) ⚠️

- [x] T037 [P] [US3] Non-routine guard test in `tests/integration/non-routine-escalation.test.ts`: a non-routine `appointment_type` ⇒ `escalate_to_human`, no booking/hold created, `escalated` audit row with reason

### Implementation for User Story 3

- [x] T038 [US3] Implement the routine-type allowlist guard (reject non-routine → `OutOfScopeError` → `escalate_to_human`) at the entry of `src/tools/get-availability.ts` and `src/tools/hold-slot.ts` — make T037 pass

**Checkpoint**: All user stories are independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [x] T039 [P] Add unit tests for edge cases in `tests/unit/` not already covered (override `0` closed day, grid boundaries, timezone)
- [x] T040 [P] Enforce `audit_log` append-only at the DB level (revoke `UPDATE`/`DELETE` or add a guard trigger) via a migration in `src/db/migrations/`
- [x] T041 Run the [quickstart.md](quickstart.md) validation (all 8 scenarios) end-to-end with fakes and fix any gaps
- [x] T042 [P] Write `README.md` with setup, migrate/seed, and the three test commands
- [x] T043 **[SUPERSEDED — `pnpm perf:smoke` / perf.yml report the full-turn p95 (availability → hold → confirm) and zero overbooking on every run.]** Verify `get_availability` p95 < 200 ms over a 30-day horizon at demo scale (optional perf check)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Setup. **Blocks all user stories.**
- **User Stories (Phase 3–5)**: all depend on Foundational. US1 is the MVP; US2 and US3 build on US1's tools but are independently testable.
- **Polish (Phase 6)**: after the desired stories are complete.

### User Story Dependencies

- **US1 (P1)**: after Foundational. No dependency on other stories.
- **US2 (P2)**: after Foundational; extends `get_availability` (US1's T029). Independently testable.
- **US3 (P2)**: after Foundational; reuses `escalate_to_human` (T021) and the entry tools (T029/T030). Independently testable.

### Within Each Story

- Tests are written and FAIL before implementation (constitution: Test-First).
- Pure domain (`availability`, `booking`) before tools; tools before the sweep/wiring.
- US1 order: T022–T026 (tests) → T027/T028 (domain) → T029 → T030 → T031 → T032.

### Parallel Opportunities

- Setup: T003, T004, T005 in parallel after T002.
- Foundational: T007, T008, T009 in parallel; T012–T015 (repos/seed) in parallel; T016/T017 (tests) in parallel, then T018/T019; T020 before T021.
- US1 tests T022–T026 all in parallel (different files); domain T027/T028 in parallel.
- US2 tests T033/T034 in parallel. US3 single test T037.

---

## Parallel Example: User Story 1

```bash
# 1) Write all US1 tests first (parallel) and watch them FAIL:
Task: "T022 availability test in tests/integration/get-availability.test.ts"
Task: "T023 MANDATORY concurrency test in tests/concurrency/hold-slot.concurrency.test.ts"
Task: "T024 hold test in tests/integration/hold-slot.test.ts"
Task: "T025 confirm test in tests/integration/confirm-booking.test.ts"
Task: "T026 e2e happy-path in tests/integration/booking-e2e.test.ts"

# 2) Then the pure domain in parallel:
Task: "T027 implement src/domain/availability.ts"
Task: "T028 implement src/domain/booking.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational (CRITICAL) → 3. Phase 3 US1 → 4. **STOP and VALIDATE**: T023 (no overbooking) + T026 (e2e) green → 5. Demo the deterministic foundation.

### Incremental Delivery

Foundation → US1 (MVP, demo) → US2 (alternatives) → US3 (escalation guard) → Polish. Each story adds value without breaking the previous ones.

---

## Notes

- `[P]` = different files, no dependency on incomplete tasks.
- The concurrency test (**T023**) is the hard gate — it must stay green through every later change.
- Every write goes through `audit_log` in the same transaction (verified across T020/T024/T025/T037).
- No LLM in this slice; only the deterministic tools write. `get_availability` is the single source of slots.
- Commit after each task or logical group; verify tests fail before implementing.
