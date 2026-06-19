# Phase 0 Research: Deterministic Booking Foundation

All decisions below resolve the Technical Context. No `NEEDS CLARIFICATION` remain — the stack is fixed by [SPEC.md](../../SPEC.md) and the clarified spec; the open technical choices are decided here with rationale.

## 1. Runtime & tooling

- **Decision**: TypeScript on Node 20+, with **Bun** as the package manager and script runner; **Vitest** as the test framework.
- **Rationale**: SPEC.md fixes TS + Vitest. Bun is the user's preferred PM/runner. Bun runs the `pg` driver and Vitest fine; we keep Vitest (not `bun test`) because SPEC.md names it and the concurrency suite benefits from Vitest's fixtures/config.
- **Alternatives**: `npm`/`pnpm` (rejected: user preference is Bun); `bun test` (rejected: SPEC.md specifies Vitest).

## 2. Postgres access layer

- **Decision**: Raw `pg` (node-postgres) with parameterized SQL and plain SQL migrations. No ORM.
- **Rationale**: The no-overbooking invariant needs **explicit control of transactions and advisory locks**. An ORM hides exactly the transaction boundaries we must reason about. YAGNI: a single clinic with a handful of tables does not justify an ORM.
- **Alternatives**: Prisma (rejected: hides tx/lock control, heavy); Drizzle/Kysely (viable typed query builders, reconsider later for type-safety — not needed now).

## 3. Atomic hold / no overbooking (core invariant)

- **Decision**: Per-slot **`pg_advisory_xact_lock`** inside a transaction. Flow: `BEGIN` → `pg_advisory_xact_lock(hash(slot_start))` → recompute `used(T)` = confirmed + active holds for that slot → if `used < capacity(T)` insert the hold (`status='held'`, `expires_at = now + 10m`) → write `audit_log` → `COMMIT` (lock auto-releases on commit).
- **Rationale**: Serializes only contenders for the **same slot**, so different slots never block each other. Deterministic, simple, and exactly the approach SPEC.md prescribes ("advisory lock on the slot → recheck used < capacity → insert"). Counting both `confirmed` and active `held` rows enforces the invariant across the hold lifecycle.
- **Alternatives**: `SERIALIZABLE` isolation + retry (rejected: more aborts, retry complexity); exclusion constraint (rejected: models a binary slot, not a capacity counter > 1); a materialized per-slot counter row with `SELECT … FOR UPDATE` (rejected: extra rows/state to keep consistent).

## 4. Hold expiry (TTL = 10 minutes)

- **Decision**: **Lazy expiry** in all reads (a hold counts only while `status='held' AND expires_at > now`) **plus** a periodic **sweep job** (`jobs/expire-holds.ts`) that transitions `held → expired` and audits the release.
- **Rationale**: Correctness must not depend on a job firing on time — lazy filtering guarantees an expired hold never blocks capacity even if the sweep is late. The sweep keeps state clean and produces an audit trail for the release. Both layers use the injected `Clock`.
- **Alternatives**: Cron-only (rejected: race window where an expired-but-not-swept hold still counts); lazy-only (rejected: stale rows accumulate, no release audit event).

## 5. Capacity model (pooled)

- **Decision**: `capacity(T) = override(date, slot) ?? rule(weekday, slot)`, capped by the number of chairs. `free(T) = capacity(T) − confirmed(T) − activeHolds(T)`. A slot is offerable when `free(T) > 0`.
- **Rationale**: Matches SPEC.md's pooled model — capacity is a seat counter, not a professional binding. Override takes precedence over the default rule (including `0` = closed).
- **Alternatives**: Per-professional calendars (rejected: `assigned` mode is OUT of scope).

## 6. Slot grid, duration & horizon

- **Decision**: 30-minute grid aligned to business hours; uniform **30-minute** duration for every routine type (MVP); offer only slots in **[now + 2h, now + 30d]**; timezone **America/Sao_Paulo**. Demo defaults: Mon–Fri 09:00–18:00, capacity 2 (config-driven, may be hardcoded for the demo).
- **Rationale**: Directly encodes the `/speckit-clarify` answers. Uniform duration keeps `get_availability` and the capacity counter simple; per-type durations are deferred.
- **Alternatives**: Variable per-type durations / 60-min grid (rejected in clarify).

## 7. Ports & fakes

- **Decision**: Define `CalendarPort`, `MessagingPort`, and `Clock` interfaces; provide in-memory fakes for tests and local dev. Real adapters (Google Calendar API + watch/sync; WhatsApp via Evolution API then Cloud API) are **deferred** to later slices.
- **Rationale**: The constitution explicitly sanctions these ports and mandates no direct Calendar/WhatsApp calls without a testable layer. Fakes let the entire slice run and be tested offline.
- **Alternatives**: Hitting real APIs in tests (rejected: non-deterministic, slow, sanctioned against).

## 8. Idempotency

- **Decision**: `hold_slot` takes an **idempotency key** (the patient's phone / conversation id); a repeat for the same patient+slot returns the existing active hold instead of a second one. `confirm_booking` is keyed by `hold_id`; if already confirmed it returns the existing booking. `CalendarPort.createEvent` receives the booking id as an idempotency key so a retry returns the same `google_event_id` — never a duplicate event.
- **Rationale**: Satisfies the spec's idempotency requirements (FR-009) and the SPEC.md tests ("second hold by same patient does not duplicate"; "repeated confirm does not duplicate"). This refines SPEC.md's `hold_slot(slot)` signature by adding the idempotency key — justified by the dedup guarantee.
- **Alternatives**: No key (rejected: cannot dedup re-deliveries/double-taps inherent to WhatsApp).

## 9. Calendar-write failure handling (FR-021)

- **Decision**: Inside `confirm_booking`, retry the calendar write briefly (up to 3 attempts, short backoff). If it still fails → `escalate_to_human` **and release the hold**; **never** send a patient confirmation without a written event.
- **Rationale**: Encodes the clarify answer (retry → escalate + release). Covers transient network failures while preserving the invariant "no confirmation without a written event."
- **Alternatives**: Retain hold + escalate (the recommended option, not chosen by the user); immediate release (rejected: drops transient failures).

## 10. Audit trail

- **Decision**: Append to `audit_log` in the **same transaction** as every state change (hold, confirm, release/expire, escalate).
- **Rationale**: Atomic trace — a write and its audit row commit or roll back together. Required by Principle V and used to debug a wrong booking.

## 11. Determinism / injected clock

- **Decision**: A `Clock` port (`now()`) is injected everywhere time is read (TTL, horizon, expiry, sweep).
- **Rationale**: Makes TTL/horizon/expiry tests deterministic without real sleeps; the concurrency test can freeze time.

## 12. Error taxonomy

- **Decision**: Explicit, typed errors: `SlotUnavailableError` (capacity gone at hold/confirm), `HoldExpiredError` (confirm after TTL), `OutOfScopeError` (non-routine → escalate), `CalendarWriteError` (after retries → escalate + release). All recoverable, never silent.
- **Rationale**: CLAUDE.md and the constitution require explicit, tractable booking errors. Each maps to a defined patient-facing recovery (re-offer slots / escalate) in the later conversational slice.
