# Tasks: Appointment Reminders and Attendance Confirmation

**Input**: `/specs/007-appointment-reminders/` (spec, plan, research, data-model, contracts/reminders.md, quickstart)
**Tests**: required (constitution I — TDD); every test task precedes its implementation.

## Phase 1: Setup

- [x] T701 Migration `src/db/migrations/012_reminders.sql` (columns, index, outbox kind, `template jsonb`); types: `Booking.reminderSentAt`/`unconfirmedNoticeAt`, `OutboxKind` += `appointment_reminder`, `OutboxRow.template`, `AuditAction` += `reminder_enqueued` | `attendance_confirmed` | `unconfirmed_notified`
- [x] T702 [P] Config: `REMINDER_LEAD_MS`, `UNCONFIRMED_NOTICE_LEAD_MS`, `REMINDERS_INTERVAL_MS`, env readers (`REMINDERS_ENABLED`, `REMINDER_LEAD_HOURS`, `UNCONFIRMED_NOTICE_LEAD_HOURS`, `WHATSAPP_REMINDER_TEMPLATE`, `_LANG`)

## Phase 2: Foundational

- [x] T703 [P] Unit tests: `isStrictAffirmative` (accepts "sim", "Sim!", "confirmo", "pode confirmar", "ok", "👍", "estarei lá", the button text; rejects "sim, mas…", "não", "sim? que horas?", long text) and the opt-out classifier ("me tira da lista" = opt-out; "me tira dessa consulta" ≠ opt-out) in `tests/unit/intent.test.ts`
- [x] T704 Implement in `src/agent/intent.ts` — make T703 pass
- [x] T705 [P] Unit tests `tests/unit/messages-reminders.test.ts`: reminder text, template params (no newlines), attendance reply, unconfirmed notice
- [x] T706 Implement in `src/messages.ts` — make T705 pass
- [x] T707 [P] Messaging tests: Cloud adapter sends `type: "template"` with body parameters when a template is given and text otherwise; Evolution sends text; `FakeMessaging` records the template; Cloud parser maps `button` and `interactive.button_reply` to text
- [x] T708 Implement the port change, adapters, fake, parser and the dispatcher passing the template — make T707 pass

## Phase 3: User Story 1 — reminder + "SIM" (P1) 🎯 MVP

- [x] T709 [P] [US1] Integration tests `tests/integration/reminders-job.test.ts`: timing table, idempotent re-run, two concurrent runs → one reminder, template stored when configured, opted-out / never consented / booked late / patient_confirmed / cancelled excluded; opt-out before delivery cancels the queued reminder
- [x] T710 [US1] Implement `src/db/repositories/reminder-repo.ts` + `src/jobs/reminders.ts` (`enqueueDueReminders`) + scheduler registration — make T709 pass
- [x] T711 [P] [US1] Integration tests `tests/integration/confirm-attendance.test.ts` (confirmed → patient_confirmed, reply via outbox, audit, idempotent, foreign → not found, past → not changeable)
- [x] T712 [US1] Implement `src/tools/confirm-attendance.ts` — make T711 pass
- [x] T713 [P] [US1] Orchestrator tests `tests/integration/orchestrator-reminder.test.ts`: "sim" → attendance confirmed, 0 model calls, one reply; precedence (opt-out first; consent capture first; handed-off untouched; two pending reminders → model; live hold → model; "sim, mas…" → model)
- [x] T714 [US1] Implement the fast path in `src/agent/orchestrator.ts` — make T713 pass

## Phase 4: User Story 2 — "não vou poder ir" / "remarcar" (P1)

- [x] T715 [P] [US2] Tests: the model receives the booking-context line after the dated line (cached prefix unchanged); the booking is pre-surfaced in the current turn; `confirm_attendance` allowed now, `cancel_booking` needs the round trip; `confirm_attendance` refused `not_surfaced` for another booking
- [x] T716 [US2] Implement the context line (`src/agent/system-prompt.ts`), pre-surfacing, the `confirm_attendance` tool schema + registry case — make T715 pass
- [x] T717 [US2] Cancel/reschedule cancel a still-pending reminder of the released booking (same transaction) + tests in `cancel-booking.test.ts` / `reschedule-booking.test.ts`

## Phase 5: User Story 3 — reception knows who did not answer (P2)

- [x] T718 [P] [US3] Integration tests for `notifyUnconfirmed` (once; not for patient_confirmed / cancelled / unreminded / started)
- [x] T719 [US3] Implement `notifyUnconfirmed` + scheduler registration — make T718 pass

## Phase 6: User Story 4 — official channel (P3)

- [x] T720 [P] [US4] Composition tests: Cloud + reminders on + no template → `NotConfigured`; reminders off or Evolution → fine; the job attaches the template from env
- [x] T721 [US4] Implement in `src/composition.ts` + `.env.example`

## Phase 7: Prompt, golden set, docs

- [x] T722 `prompts/system/v003.md` + CHANGELOG (reminder context, attendance confirmation)
- [x] T723 Eval harness: category `reminder`; seeds `reminderSentAt`, `createdAt`; `writes.attendanceConfirmations`
- [x] T724 Cases `rem-01`…`rem-07`, `inj-14`; `resched-04` becomes a real flow; `evals/live-subset.txt` for this PR
- [x] T725 [P] README (what it does, guarantees, roadmap), CLAUDE.md, ADR 0010 if a decision needs it, quickstart
- [x] T726 Gates: lint, typecheck, `test:coverage`, `evals:fake`, `evals:readme --check`
- [ ] T727 Live: labelled subset (≤ US$ 0.50); after merge, the single full re-baseline (≤ US$ 0.80) published through a PR
- [ ] T728 Codex review (xhigh) + self-review; fix all findings; tick this file

## Dependencies
Setup → Foundational → US1 → US2 → US3 → US4 → prompt/evals/docs. US3 needs US1's `reminder_sent_at`. US4 can follow US1 in parallel with US2.
