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
| `status` | text enum | `held` \| `confirmed` \| `patient_confirmed` \| `cancelled` \| `done` \| `expired` |
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

### `audit_log` — append-only trace

| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `entity` | text | e.g. `booking` |
| `entity_id` | uuid | |
| `action` | text | `hold_created` \| `hold_expired` \| `booking_confirmed` \| `hold_released` \| `escalated` |
| `actor` | text | `ai` \| `system` \| `human` |
| `payload` | jsonb | before/after snapshot or context |
| `created_at` | timestamptz | |

Append-only: no `UPDATE`/`DELETE` (enforce by convention + revoked grants later). Written in the **same transaction** as the state change it describes.

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

1. **No overbooking**: for every slot `T`, `count(status='confirmed') + count(status='held' AND expires_at > now) ≤ capacity(T)`. (Mandatory concurrency test.)
2. `expires_at IS NOT NULL` ⇔ `status='held'`.
3. `google_event_id IS NOT NULL` ⇒ `status IN ('confirmed','patient_confirmed','done')`.
4. Every state-changing row has a matching `audit_log` row committed in the same transaction.
5. Offered slots satisfy: grid-aligned, within business hours, `start_ts ∈ [now+2h, now+30d]`, `free(T) > 0`.

## Validation rules

- `appointment_type` ∈ routine set, else → `OutOfScopeError` (escalate).
- `start_ts` aligned to the 30-min grid and within business hours, else not offered.
- `capacity ≥ 0`; `end_time > start_time` on rules/overrides.
