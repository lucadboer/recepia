# Contract: Deterministic Booking Tools

These are the **only writers** in the system. The LLM (later slice) may call them but never bypasses them. Format per the POS reference: **API + Guarantees + Required Tests** (tests written BEFORE implementation, per Principle I). Signatures are TypeScript-shaped; types live in `src/domain` / `src/tools`.

Shared types:

```ts
type AppointmentType = 'evaluation' | 'cleaning' | 'follow_up' | 'consultation';
type Slot = { start: Date; end: Date; type: AppointmentType };
type Period = { from: Date; to: Date };           // clamped to [now+2h, now+30d]
type PatientRef = { phone: string };               // WhatsApp identity + idempotency key
type Patient = { phone: string; name: string };
```

---

## `get_availability(period, appointmentType) -> Slot[]`

The **single source of bookable times**. Pure read over capacity + bookings + active holds.

**Guarantees**
- Returns only slots with `free(T) > 0`, where `free(T) = capacity(T) − confirmed(T) − activeHolds(T)`.
- Respects business hours and the type's duration (uniform 30 min, MVP); never returns a slot outside business hours or that cannot fit the duration.
- Applies `capacity_override` over the default `capacity_rule` (including `0` = closed).
- Clamps results to `[now+2h, now+30d]`; 30-min grid aligned; `America/Sao_Paulo`.
- Deterministic for a fixed DB state + `Clock`.

**Required Tests**
- Returns empty when capacity is exhausted for the period.
- Honors `capacity_override` (e.g., override 1 caps to 1; override 0 yields none).
- Never returns a slot outside business hours, off-grid, before `now+2h`, or after `now+30d`.
- An active (non-expired) hold reduces `free(T)`; an expired hold does **not**.

---

## `hold_slot(slot, patientRef) -> Hold`

Atomic temporary reservation. `Hold = { id: string; slot: Slot; expiresAt: Date }`.

**Guarantees**
- **Atomic** under concurrency via per-slot advisory lock: lock(slot) → recheck `used(T) < capacity(T)` → insert `held` with `expires_at = clock.now() + 10m` → audit → commit.
- Never lets `held + confirmed` exceed `capacity(T)` for the slot (no overbooking).
- **Idempotent** per `patientRef`: a repeat for the same patient + slot returns the existing active hold (no duplicate).
- Expires on its own (lazy in reads + sweep job); an expired hold frees the seat.
- Fails with `SlotUnavailableError` when the slot filled up before the lock was acquired.
- Writes an `audit_log` (`hold_created`) row in the same transaction.

**Required Tests** *(constitution-mandated concurrency test lives here)*
- **N concurrent `hold_slot` on one slot with capacity C ⇒ exactly C succeed, N−C raise `SlotUnavailableError`; DB shows ≤ C active holds.** (MANDATORY)
- A second `hold_slot` for the same `patientRef` + slot does not create a duplicate (returns the same hold).
- An expired hold releases the seat (a later `hold_slot` succeeds).
- `hold_slot` on a full slot raises `SlotUnavailableError`.

---

## `confirm_booking(holdId, patient) -> Booking`

Commits a held slot: writes the calendar event and the patient confirmation.

**Guarantees**
- Requires a valid, non-expired hold; otherwise `HoldExpiredError` (explicit, recoverable — caller re-offers slots). Never writes silently.
- Writes **exactly one** event via `CalendarPort.createEvent` (idempotency key = booking id), sets `google_event_id`, flips `status='held' → 'confirmed'`, and *(amended 2026-10-05, 002 Phase 11)* **enqueues** the pt-BR confirmation as an `outbox_message` row **in the same transaction** as the flip and the `booking_confirmed` audit row (whose payload carries the `outboxId`). Delivery happens through `dispatchOutbox` (at-least-once, retries, dead-letter + reception notification) — see `specs/002-conversational-orchestration/contracts/orchestration.md`.
- Returns `{ booking, outcome: "confirmed" | "already_confirmed" }`; the booking value is assigned only after the transaction's COMMIT resolves (a failed COMMIT never yields a confirmed result).
- **Idempotent**: a repeat for an already-confirmed hold returns the same booking with `outcome: "already_confirmed"`; no duplicate event or outbox row.
- On calendar-write failure: retry briefly (≤ 3, short backoff); if still failing → `escalate_to_human` + release the hold + raise `CalendarWriteError`; **no** patient confirmation without a written event (FR-021).
- Writes `audit_log` (`booking_confirmed`) in the same transaction as the state flip.

**Required Tests**
- Confirming a valid hold writes exactly one calendar event and one confirmation message.
- Confirming an expired hold raises `HoldExpiredError` and writes nothing.
- Repeated confirm does not duplicate the event/booking/message (idempotent).
- Calendar failure that persists → escalation fired, hold released, no confirmation sent, `CalendarWriteError` raised.
- Confirmation message is in Portuguese (FR-019).

---

## `escalate_to_human({ reason, phone, context, summary? }) -> void`

Hands a request to reception and ends the autonomous attempt. *(Signature amended 2026-10-05, 002 Phase 11 — previously `(reason, context)`.)*

**Guarantees**
- Notifies reception with the patient's `phone` (null only for patient-less system escalations such as an empty horizon), the `reason`, the triggering `context`, and an optional deterministic `summary` (last patient/assistant lines; never LLM-generated).
- The reception notification is enqueued as an `outbox_message` row **in the same transaction** as the `escalated` audit row (payload: `reason`, `context`, `phone`, `summary`, `outboxId`); delivery via `dispatchOutbox` (at-least-once).
- Creates no booking/hold; ends the autonomous attempt (the orchestrator enters the handed-off state).
- Reasons covered in this slice: non-routine type (`OutOfScopeError`), empty horizon (no free slot within 30 days), unrecoverable calendar failure, ambiguity.

**Required Tests**
- A non-routine request triggers escalation and creates no booking/hold.
- An empty-horizon availability result triggers escalation rather than a dead end.
- Escalation writes an audit row with reason + context.
