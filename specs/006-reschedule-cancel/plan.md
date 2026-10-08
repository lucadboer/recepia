# Implementation Plan: Reschedule and Cancel over WhatsApp

**Branch**: `006-reschedule-cancel` | **Date**: 2026-10-08 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/006-reschedule-cancel/spec.md`

## Summary
Three new deterministic tools behind the existing registry: `find_my_booking` (read; exactly one upcoming booking of the conversation's phone, otherwise a code-driven hand-off), `cancel_booking(booking_id)` and `reschedule_booking(booking_id, hold_id)`. Two new structural gates join the three of 002: **`not_surfaced`** (the booking was not returned by `find_my_booking` in this conversation) and **`confirmation_required`** (the booking — or, for a reschedule, the new hold — was first shown in the current inbound turn, so the patient has not replied yet). A reschedule creates a **new booking row** from a hold made through the normal `get_availability → hold_slot` path and cancels the old row in the same transaction (`rescheduled_from` link, partial unique index = at most one successful reschedule per booking). Calendar: new event first (idempotent by the new booking id), then the DB transaction, then delete the old event; cancel is DB-first then delete. A delete that keeps failing leaves Postgres as the source of truth and commits a reception notice to remove the event by hand. Late changes (< 24 h) add a reception notice in the same transaction. Prompt v002 teaches the flows; the golden set gains real reschedule/cancel cases and adversarial ones.

## Technical Context
- **Language/Version**: TypeScript on Node 24 (engines ≥ 22.12), ESM, `tsx`.
- **Primary Dependencies**: none new.
- **Storage**: PostgreSQL — migration `011_booking_lifecycle.sql`: `booking.cancelled_at timestamptz` + `CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))`; `booking.rescheduled_from uuid REFERENCES booking(id)` + `UNIQUE (rescheduled_from) WHERE rescheduled_from IS NOT NULL`; index `(patient_phone, start_ts) WHERE status IN ('confirmed','patient_confirmed')`; outbox `kind` CHECK gains `booking_cancellation` and `reception_notice`. New audit actions `booking_cancelled`, `booking_rescheduled`, `calendar_delete_failed`. `conversation_state.state` JSON gains `turnSeq`, `surfacedBookings`, `holdSeqs` (legacy rows default).
- **Testing**: Vitest — unit (state reducers, messages, error replies), integration against Postgres (tools, registry gates, orchestrator flows), concurrency (`tests/concurrency/booking-lifecycle.concurrency.test.ts`), golden set (`pnpm evals:fake`), one labelled live subset run (≤ US$ 0.40).
- **Target Platform**: Node service (webhook + in-process jobs).
- **Project Type**: web service.
- **Performance Goals**: no measurable change to the perf smoke; one extra round trip per destructive action (FR-603) is accepted.
- **Constraints**: the LLM never writes (constitution II); no new dependency; no `CalendarPort.updateEvent`; live spend ≤ US$ 0.70 for this feature (owner budget).
- **Scale/Scope**: one clinic; patients with at most one upcoming booking handled autonomously.

## Constitution Check
| Principle | Status | Compliance |
|---|---|---|
| I Test-First | ✅ | Tools, gates, reducers and orchestrator flows are written test-first; a new concurrency test proves no overbooking and at most one reschedule under races (cancel × reschedule, holds on a freed seat, reschedules into a contested time). The existing no-overbooking gate is untouched. |
| II LLM Never Writes | ✅ | All writes go through deterministic tools; the model supplies only ids that were shown to it; the phone comes from the conversation; the new time comes only from `hold_slot` (gate 2 + advisory lock); the patient name is copied from the old booking. Two new structural gates (`not_surfaced`, `confirmation_required`). |
| III Simplicity/YAGNI | ✅ | No new dependency, no `updateEvent`; reschedule reuses `holdSlot`/`confirmHeld`; the calendar retry helpers move to `src/tools/booking-calendar.ts` only because there are now two consumers (confirm + reschedule/cancel). |
| IV Escalate on Doubt | ✅ | None or several upcoming bookings → hand-off by code; calendar failure on a reschedule → hand-off; explicit confirmation is structural (FR-603). |
| V Traceability/LGPD | ✅ | Every write audited in the same transaction (prompt version on model-driven writes); reschedule links new → old; cancel works after an opt-out (reduces data); reschedule requires consent. |

Gate: **pass**.

## Project Structure

### Documentation (this feature)
```text
specs/006-reschedule-cancel/
├── plan.md
├── research.md          # R1 tool surface, R2 confirmation gate, R3 reschedule as new row, R4 calendar ordering/compensation, R5 late notice, R6 consent, R7 evals + live spend
├── data-model.md
├── quickstart.md
├── contracts/booking-lifecycle.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)
```text
src/
├── db/migrations/011_booking_lifecycle.sql
├── db/repositories/booking-repo.ts     # findUpcomingForPhone, lockForUpdate, cancelActive, confirmHeld(+rescheduledFrom), findRescheduleOf
├── db/repositories/outbox-repo.ts      # OutboxKind += booking_cancellation | reception_notice
├── db/repositories/audit-repo.ts       # AuditAction += booking_cancelled | booking_rescheduled | calendar_delete_failed
├── domain/errors.ts                    # BookingNotFoundError, BookingNotChangeableError
├── tools/booking-calendar.ts           # writeEventWithRetry, deleteEventWithRetry (extracted from confirm-booking)
├── tools/confirm-booking.ts            # uses booking-calendar helpers (no behaviour change)
├── tools/find-my-booking.ts
├── tools/cancel-booking.ts
├── tools/reschedule-booking.ts
├── tools/late-change.ts                # isLateChange(start, now) + reception notice enqueue
├── messages.ts                         # cancellation / reschedule / reception-notice pt-BR text
├── agent/types.ts, agent/conversation.ts  # turnSeq, surfacedBookings, holdSeqs + reducers, bounds, reset
├── agent/tool-schemas.ts               # 3 new strict tool definitions
├── agent/tool-registry.ts              # 3 new cases + gates not_surfaced / confirmation_required
├── agent/orchestrator.ts               # turnSeq per inbound; consent gate also for reschedule_booking
├── agent/reply.ts                      # errorReply for the new errors
├── jobs/dispatch-outbox.ts             # a dead reception_notice is handled like an escalation (no second one)
└── db/conversation-store (DbConversationStore.load) # legacy defaults
prompts/system/v002.md, prompts/CHANGELOG.md
evals/lib/{case-schema,assertions,runner,script}.ts, evals/cases/resched-*.json + new cases
tests/{unit,integration,concurrency}/…
docs/adr/0009-reschedule-as-new-row.md
```

**Structure Decision**: single project; the three tools follow the 001 pattern (pure deterministic functions over `Deps`), the registry stays the only place where model input meets a write path.

## Complexity Tracking
| Item | Why needed | Simpler alternative rejected because |
|---|---|---|
| `confirmation_required` gate (turn counter) | constitution IV "explicit confirmation before any commit" for destructive actions | relying on the prompt alone is not structural; parsing "sim" deterministically would duplicate the model's language understanding badly |
| Reschedule as a new row | keeps `holdSlot` as the only seat allocator and one calendar event id per booking | updating the row in place needs `updateEvent`, re-implements seat allocation and loses the history |
