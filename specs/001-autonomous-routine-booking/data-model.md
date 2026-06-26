# Phase 1 Data Model: Deterministic Booking Foundation

Source of truth split (per SPEC.md): **Google Calendar** = confirmed events; **Postgres** = capacity, holds, booking state, sync, audit. Timezone is `America/Sao_Paulo`; all timestamps stored as `timestamptz`.

## Entities

### `capacity_rule` — default pooled capacity

| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `weekday` | smallint | 0–6 (0 = Sunday) |
| `start_time` | time | inclusive |
| `end_time` | time | exclusive |
| `capacity` | smallint | ≥ 0, capped by chairs |

Demo seed: Mon–Fri, 09:00–18:00, capacity 2.

### `capacity_override` — one-off adjustment (takes precedence)

| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `date` | date | the affected day |
| `start_time` | time | inclusive |
| `end_time` | time | exclusive |
| `capacity` | smallint | ≥ 0 (`0` = closed) |

`capacity(T) = override(date, slot) ?? rule(weekday, slot)`.

### `booking` — appointment request / hold / confirmation

| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | also the idempotency key for the calendar event |
| `patient_name` | text | collected in conversation (nullable while `held`) |
| `patient_phone` | text | WhatsApp number; patient identity + hold idempotency key |
| `appointment_type` | text | routine set: `evaluation` \| `cleaning` \| `follow_up` \| `consultation` |
| `start_ts` | timestamptz | 30-min grid aligned |
| `end_ts` | timestamptz | `start_ts + 30 min` (uniform MVP) |
| `status` | text enum | `held` \| `confirmed` \| `patient_confirmed` \| `cancelled` \| `done` \| `expired` (`cancelled`/`expired` are terminal & free the seat) |
| `seat` | smallint | seat index assigned on hold — `holdSlot` picks the lowest free seat in `[0, capacity)`. Backs the seat-collision guarantee; the capacity cap itself is enforced by `holdSlot`, not by the DB (see Indexes / Invariants) |
| `expires_at` | timestamptz | set **iff** `status='held'`; `start_ts`-independent (= hold creation + 10m) |
| `google_event_id` | text | set on confirm; null while held; idempotency anchor |
| `attended_by` | text | nullable (pooled — usually null in this slice) |
| `created_via` | text enum | `ai` \| `human` |
| `consent_at` | timestamptz | LGPD opt-in timestamp; **nullable**. Captured upstream by the conversational layer; the deterministic tools assume consent was given and stamp it on confirm. |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

**Indexes**
- `(start_ts, status)` — fast per-slot counting for availability.
- Partial index on `(start_ts)` where `status='held'` — sweep + active-hold counting.
- Partial unique on `(patient_phone, start_ts)` where `status='held'` — enforces hold idempotency (no duplicate active hold for same patient+slot).
- **Partial unique on `(start_ts, seat)` where `status NOT IN ('cancelled','expired')`** — the seat-collision backstop: at most one active booking per `(slot, seat)`. This does **not** enforce `seat < capacity` — a direct writer using `seat >= capacity` would bypass the cap. The capacity cap is enforced by `holdSlot` (the sole writer), which assigns seats in `[0, capacity)` under the advisory lock; the lock is what actually caps a slot at its capacity. A true per-resource structural cap is deferred to the 003 resource-based model.

### `audit_log` — append-only trace

| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `entity` | text | e.g. `booking` |
| `entity_id` | uuid | |
| `action` | text | `hold_created` \| `hold_expired` \| `booking_confirmed` \| `hold_released` \| `calendar_orphan_compensated` \| `escalated` |
| `actor` | text | `ai` \| `system` \| `human` |
| `payload` | jsonb | before/after snapshot or context |
| `created_at` | timestamptz | |

Append-only: `UPDATE`/`DELETE`/`TRUNCATE` are blocked by DB triggers (migrations 002–003). Written in the **same transaction** as the state change it describes (`appendAudit` requires the transaction's client).

## Derived (non-persisted)

### `Slot`
`{ start: timestamptz, end: timestamptz, type: appointment_type }` — a grid window with `free(T) > 0`. Produced only by `get_availability`; the single legitimate source of offered times.

## Booking state machine (this slice)

```text
        hold_slot                  confirm_booking (event written)
  ─────────────────▶  held  ──────────────────────────────────────▶  confirmed
                       │
                       │ TTL elapses (lazy) / sweep job
                       ▼
                    expired

  held ── confirm fails after calendar retries ──▶ released (→ expired) + escalate
```

- `patient_confirmed`, `cancelled`, `done` exist in the enum but their transitions belong to US2/US3 (out of scope here).
- Transition guard: `held → confirmed` requires `expires_at > now` (else `HoldExpiredError`) **and** a written calendar event.

## Invariants (test targets)

1. **No overbooking**: for every slot `T`, `holdSlot` (the sole writer) assigns active bookings (`status NOT IN ('cancelled','expired')`) to distinct seats in `[0, capacity(T))` under an advisory lock, so their count ≤ `capacity(T)`. The `(start_ts, seat)` partial unique index structurally prevents two active bookings from sharing a seat (proven by the lock-bypass test), but does **not** by itself enforce `seat < capacity` — that cap is the writer's responsibility (mandatory concurrency test; characterization test pins the gap). A fully DB-enforced per-resource cap is deferred to 003.
2. `expires_at IS NOT NULL` ⇔ `status='held'`.
3. `google_event_id IS NOT NULL` ⇒ `status IN ('confirmed','patient_confirmed','done')`.
4. Every state-changing row has a matching `audit_log` row committed in the same transaction.
5. Offered slots satisfy: grid-aligned, within business hours, `start_ts ∈ [now+2h, now+30d]`, `free(T) > 0`.

## Validation rules

- `appointment_type` ∈ routine set, else → `OutOfScopeError` (escalate).
- `start_ts` aligned to the 30-min grid and within business hours, else not offered.
- `capacity ≥ 0`; `end_time > start_time` on rules/overrides.
