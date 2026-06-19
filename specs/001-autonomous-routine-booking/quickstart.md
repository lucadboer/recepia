# Quickstart: Deterministic Booking Foundation

Run and validate User Story 1's deterministic layer end-to-end **without any LLM, real Calendar, or real WhatsApp** (fakes only). Implementation details live in `tasks.md`; this is a run/validation guide.

## Prerequisites

- **Bun** (package manager + runner), Node 20+ toolchain.
- **PostgreSQL** reachable via `DATABASE_URL` (local Docker is fine):
  ```bash
  docker run --rm -d --name recepia-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16
  export DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres
  ```

## Setup

```bash
bun install
bun run migrate          # applies src/db/migrations (capacity_rule, capacity_override, booking, audit_log)
bun run seed             # demo capacity: Mon–Fri 09:00–18:00, capacity 2 (America/Sao_Paulo)
```

## Run the test suites

```bash
bun run test:unit         # pure domain: capacity, availability, slot grid, state machine
bun run test:integration  # tools against real Postgres + fakes (Calendar/Messaging/Clock)
bun run test:concurrency  # MANDATORY: N concurrent holds on one slot never exceed capacity
```

The **concurrency suite is the gate**: it must prove that firing N simultaneous `hold_slot` calls at a capacity-C slot yields exactly C holds and N−C `SlotUnavailableError`s, with the DB showing ≤ C active holds. See [contracts/booking-tools.md](contracts/booking-tools.md#hold_slotslot-patientref---hold).

## End-to-end validation scenario (fakes)

Proves Acceptance Scenario 1 + the no-overbooking guarantee. Uses `FakeCalendar`, `FakeMessaging`, `FakeClock`.

1. **Availability** — `get_availability({from, to}, 'cleaning')` returns grid-aligned slots in `[now+2h, now+30d]`, capacity 2 honored. → expect non-empty, all bookable.
2. **Hold** — `hold_slot(slot, { phone })` returns a `Hold` with `expiresAt = now + 10m`; a second call for the same phone+slot returns the **same** hold (idempotent).
3. **Confirm** — `confirm_booking(holdId, { phone, name })` writes **one** event to `FakeCalendar`, flips status to `confirmed`, and sends **one** pt-BR confirmation via `FakeMessaging`.
4. **Audit** — `audit_log` has `hold_created` then `booking_confirmed` rows for the booking.
5. **No overbooking** — concurrently hold the same slot from 3 phones at capacity 2 → exactly 2 holds; the 3rd gets `SlotUnavailableError` and is offered alternatives.
6. **Expiry** — advance `FakeClock` past `expiresAt`, run the sweep → the held seat is freed (`hold_expired` audited) and `get_availability` offers it again.
7. **Escalation** — `get_availability` for a non-routine type (or an empty 30-day horizon) → `escalate_to_human` fires, `FakeMessaging` notifies reception, no booking created.
8. **Calendar failure** — configure `FakeCalendar` to fail → `confirm_booking` retries, then escalates + releases the hold; **no** patient confirmation sent (FR-021).

## Expected outcomes (map to spec)

| Step | Spec reference |
|---|---|
| 1 | FR-001, FR-002, FR-022, SC-006 |
| 2 | FR-004, FR-009 |
| 3 | FR-007, FR-008, FR-019, SC-001 |
| 4 | FR-015, SC-005 |
| 5 | FR-005, SC-002 (no overbooking) |
| 6 | FR-006, SC-007 |
| 7 | FR-012, FR-014, SC-004 |
| 8 | FR-021 |

All eight pass with fakes ⇒ the deterministic foundation is ready for the next slice (real adapters + the conversational layer).
