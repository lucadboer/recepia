# Tasks: Reschedule and Cancel over WhatsApp

**Input**: Design documents from `/specs/006-reschedule-cancel/` (spec, plan, research, data-model, contracts/booking-lifecycle.md, quickstart)
**Tests**: required (constitution I — TDD); every test task precedes the implementation it covers.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [x] T601 Migration `src/db/migrations/011_booking_lifecycle.sql`: `booking.cancelled_at` + CHECK, `booking.rescheduled_from` FK + partial unique index, upcoming index, outbox `kind` CHECK += `booking_cancellation`, `reception_notice`; add the migration to the schema test expectations
- [x] T602 [P] Types: `OutboxKind` (+2), `AuditAction` (+3), `RejectedBy` (+`not_surfaced`, `confirmation_required`), `Booking.cancelledAt`/`rescheduledFrom` in `src/domain/types.ts` and `rowToBooking`; `BookingNotFoundError`, `BookingNotChangeableError` in `src/domain/errors.ts`

## Phase 2: Foundational (blocks all stories)

- [x] T603 [P] Unit tests `tests/unit/conversation-lifecycle-state.test.ts`: `startTurn` increments `turnSeq`; `recordSurfacedBooking`/`recordHoldTurn` store the turn and cap; `surfacedTurnOf`/`holdTurnOf`; `resetConversation` clears them and keeps `version`; `boundState` caps them; legacy state without the fields loads with defaults
- [x] T604 Implement the reducers in `src/agent/conversation.ts` + fields in `src/agent/types.ts` + defaults in the conversation store load path — make T603 pass
- [x] T605 [P] Unit tests `tests/unit/messages-lifecycle.test.ts`: `cancellationMessagePt`, `rescheduledMessagePt`, `lateChangeNoticePt`, `calendarCleanupNoticePt` (pt-BR, clinic-local time, masked nothing — reception needs the phone)
- [x] T606 Implement the messages in `src/messages.ts` — make T605 pass
- [x] T607 Extract `writeEventWithRetry` / `deleteEventWithRetry` into `src/tools/booking-calendar.ts`; `confirm-booking.ts` uses them; the existing confirm tests stay green unchanged
- [x] T608 [P] Integration tests `tests/integration/booking-repo-lifecycle.test.ts`: `findUpcomingForPhone` (only own, active, future), `cancelActive` (status + `cancelled_at`, CHECK holds), `confirmHeld` with `rescheduledFrom`, unique `rescheduled_from` rejects a second link
- [x] T609 Implement the repo functions in `src/db/repositories/booking-repo.ts` — make T608 pass

## Phase 3: User Story 1 — Cancel my appointment (P1) 🎯 MVP

**Goal**: the patient cancels their single upcoming appointment after confirming it.
**Independent test**: seeded booking → "quero cancelar" → "sim" → cancelled, event removed, one message, capacity back.

- [x] T610 [P] [US1] Integration tests `tests/integration/find-my-booking.test.ts` (found / none / multiple; ignores past, cancelled, held, other phones)
- [x] T611 [P] [US1] Integration tests `tests/integration/cancel-booking.test.ts` per the contract (capacity back, idempotent, foreign → not found with zero writes, past → not changeable, late notice, mid-transaction failure via `interceptingPool`, delete failure → `calendar_delete_failed` + cleanup notice)
- [x] T612 [US1] Implement `src/tools/find-my-booking.ts`, `src/tools/reception-notices.ts`, `src/tools/cancel-booking.ts` — make T610/T611 pass
- [x] T613 [P] [US1] Registry tests in `tests/integration/tool-registry-lifecycle.test.ts`: `find_my_booking` records the surfaced turn; `cancel_booking` refused `not_surfaced` (id never shown, other patient's id) and `confirmation_required` (same turn), accepted next turn; result content uses clinic-local time + pt-BR label
- [x] T614 [US1] Tool schemas + registry cases + `errorReply` mappings + orchestrator `startTurn` — make T613 pass
- [x] T615 [US1] Orchestrator test `tests/integration/orchestrator-cancel.test.ts` (FakeLLM: find → ask → "sim" → cancel; one patient message — the cancellation from the outbox, no extra closing text; conversation completed)

## Phase 4: User Story 2 — Move my appointment (P1)

**Goal**: the patient moves their appointment to an offered, held time; old released only when the new one is confirmed.
**Independent test**: seeded booking → find → availability → hold → "sim" → new booking linked, old cancelled, events swapped.

- [x] T616 [P] [US2] Integration tests `tests/integration/reschedule-booking.test.ts` per the contract (seats swap, events create/delete, one message, calendar create failure keeps old + releases hold + escalates, hold expired → orphan compensated, idempotent, same start / other type / foreign hold / foreign booking refused, late notice)
- [x] T617 [US2] Implement `src/tools/reschedule-booking.ts` — make T616 pass
- [x] T618 [P] [US2] Registry tests: `reschedule_booking` refused when the booking or the hold is from the current turn, when the hold is foreign, accepted when both are earlier; `hold_slot` records `holdSeqs`
- [x] T619 [US2] Registry case + consent gate for `reschedule_booking` in the orchestrator — make T618 pass
- [x] T620 [US2] Orchestrator test `tests/integration/orchestrator-reschedule.test.ts` (full flow; opted-out patient is asked for consent before the reschedule commits)

## Phase 5: User Story 3 — Hand off when it is not clear (P2)

- [x] T621 [P] [US3] Registry/orchestrator tests: two upcoming bookings or none → `escalate_to_human` called by code (`multiple_bookings` / `booking_not_found`), conversation handed off, nothing cancelled
- [x] T622 [US3] Implement the code-driven escalation in the `find_my_booking` registry case — make T621 pass

## Phase 6: Concurrency gate

- [x] T623 `tests/concurrency/booking-lifecycle.concurrency.test.ts`: 10 concurrent cancels → one audit + one message; cancel × reschedule → one winner, events = active bookings; 16 holds on a freed time (capacity 1) → 1; reschedules into one contested time → at most one, never over capacity

## Phase 7: Prompt, golden set, observability

- [x] T624 `prompts/system/v002.md` + `prompts/CHANGELOG.md` entry: cancel/reschedule flows (find first, show, ask, wait; reschedule via availability + hold; attendance confirmation still to reception)
- [x] T625 [P] Eval harness: seeds `name`/`type`/`patient_confirmed`; placeholders `$lastBookingId` (scripts) and `$ownBookingId` (matchers); `writes.cancellations|reschedules|calendarDeletes|receptionNotices` in `evals/lib/{case-schema,script,assertions,runner}.ts` + unit tests
- [x] T626 Rewrite `evals/cases/resched-01..03` as real flows (no `limitation`); keep resched-04 as the attendance limitation (007)
- [x] T627 New cases: `resched-05` late cancel, `resched-06` time taken mid-flow, `resched-07` two bookings → hand-off, `resched-08` no booking → hand-off, `resched-09` opted-out cancels / reschedule asks consent; `inj-11` id never shown, `inj-12` other patient's booking id, `inj-13` same-turn cancel then "sim"
- [x] T628 Telemetry: the tool span records `rejected_by` for the new gates (extend `tests/integration/tracing.test.ts`)
- [x] T629 `evals/live-subset.txt` for this PR: reschedule_cancel + new injection cases + 2 happy paths

## Phase 8: Polish

- [x] T630 [P] `docs/adr/0009-reschedule-as-new-row.md` + ADR index; fix stale "feature 006 = durable inbound" references (ADR 0004/0005, `src/jobs/dispatch-outbox.ts`, specs/002 plan)
- [x] T631 [P] README (what it does, guarantees table, agent guardrails, roadmap), 001 data-model lifecycle note, CLAUDE.md agent context
- [x] T632 `dispatch-outbox.ts`: a permanently failed `reception_notice` is handled like an escalation (no second escalation) + test
- [x] T633 Gates: lint, typecheck, `test:coverage` (thresholds not lowered), `evals:fake`, `evals:readme --check`
- [ ] T634 Live: labelled subset run (≤ US$ 0.40, at most one rerun ≤ US$ 0.30); record the result in the PR
- [ ] T635 Codex review (xhigh) + self-review; fix all findings; tick this file

## Dependencies & Execution Order
Setup → Foundational → US1 → US2 (needs the cancel path and the calendar helpers) → US3 → concurrency → prompt/evals → polish. Within a story, tests first. T624 (prompt) can be drafted in parallel with US2.

## Implementation Strategy
MVP = US1 (cancel) end to end, then US2, then US3. The golden set and the live subset run come last because they exercise all three.
