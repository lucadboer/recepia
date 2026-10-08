# Implementation Plan: Appointment Reminders and Attendance Confirmation

**Branch**: `007-appointment-reminders` | **Date**: 2026-10-08 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/007-appointment-reminders/spec.md`

## Summary
Two in-process jobs (every 15 min, `REMINDERS_ENABLED`): **`reminders`** claims qualifying bookings with `FOR UPDATE SKIP LOCKED` and, per booking in one transaction, stamps `reminder_sent_at`, enqueues an `appointment_reminder` outbox row (dedupe `appointment_reminder:<id>`, optional WhatsApp template) and audits `reminder_enqueued`; **`unconfirmed-notice`** stamps `unconfirmed_notice_at`, enqueues a `reception_notice` and audits `unconfirmed_notified`. Replies: after the existing dedupe → opt-out → handed-off → consent-capture steps, a **deterministic fast path** confirms attendance when there is exactly one pending reminder and the whole message is a strict affirmation (zero model calls, reply through the outbox); otherwise the model gets one **booking-context line** after the dated line (the cached prefix is untouched), the booking is recorded as shown in the current turn, and a new tool **`confirm_attendance(booking_id)`** (gate `not_surfaced` only) joins the 006 tools. `MessagingPort.sendMessage` gains an optional template; the Cloud adapter sends `type: "template"`, Evolution sends text, the Cloud parser reads button replies. Cancel/reschedule (006) also cancel a still-queued reminder of the booking they release.

## Technical Context
- **Language/Version**: TypeScript on Node 24, ESM, `tsx`.
- **Primary Dependencies**: none new.
- **Storage**: migration `012_reminders.sql`: `booking.reminder_sent_at`, `booking.unconfirmed_notice_at` (timestamptz NULL); partial index `start_ts WHERE status = 'confirmed'`; outbox `kind` += `appointment_reminder`; `outbox_message.template jsonb NULL`. Audit actions `reminder_enqueued`, `attendance_confirmed`, `unconfirmed_notified`.
- **Testing**: Vitest — unit (strict affirmative, timing predicates, messages, template payloads, button parsing), integration against Postgres (jobs with `FakeClock`, concurrent job runs, opt-out and cancel interplay, orchestrator precedence, registry), golden set `reminder` category, one labelled live subset run.
- **Target Platform / Project Type**: Node web service with in-process jobs.
- **Performance Goals**: jobs process ≤ 50 bookings per run; no effect on the turn latency budget (fast path makes zero model calls).
- **Constraints**: LLM never writes; reminders only with current opt-in; no new dependency; live spend ≤ US$ 0.50.
- **Scale/Scope**: one clinic, tens of appointments per day.

## Constitution Check
| Principle | Status | Compliance |
|---|---|---|
| I Test-First | ✅ | Jobs (timing table, concurrency of two job runs, opt-out/cancel interplay), the fast path and its precedence, the new tool and gate, adapters and parser are written test-first; no-overbooking gate unchanged. |
| II LLM Never Writes | ✅ | Reminders and notices are written by deterministic jobs; the fast path is deterministic; the model reaches `confirm_attendance` only through the registry with `not_surfaced`. |
| III Simplicity/YAGNI | ✅ | Two columns instead of a reminder table; outbox reused for every message; template support is one optional argument; no scheduler library. |
| IV Escalate on Doubt | ✅ | Anything but a plain "sim" to one pending reminder goes to the model with context; two pending reminders are never auto-confirmed; no reply → reception. |
| V Traceability/LGPD | ✅ | Every reminder, confirmation and notice audited; reminders only to current opt-ins; opt-out cancels a queued reminder; no marketing. |

Gate: **pass**.

## Project Structure
```text
specs/007-appointment-reminders/  plan.md research.md data-model.md quickstart.md contracts/reminders.md checklists/ tasks.md
src/db/migrations/012_reminders.sql
src/db/repositories/reminder-repo.ts      # claimDueReminders, claimUnconfirmed, pendingRemindersForPhone, cancelQueuedReminder
src/db/repositories/outbox-repo.ts        # kind += appointment_reminder; template column
src/ports/messaging-port.ts               # sendMessage(to, body, template?)
src/adapters/messaging/{cloud-api,evolution}-messaging.ts, inbound/cloud-api-parser.ts, fakes/fake-messaging.ts
src/jobs/reminders.ts                     # enqueueDueReminders, notifyUnconfirmed
src/jobs/scheduler.ts                     # register both (REMINDERS_ENABLED)
src/jobs/dispatch-outbox.ts               # pass the template
src/tools/confirm-attendance.ts
src/tools/{cancel,reschedule}-booking.ts  # cancel a queued reminder of the released booking
src/agent/intent.ts                       # isStrictAffirmative; opt-out not fooled by "me tira dessa consulta"
src/agent/orchestrator.ts                 # fast path + booking-context line + pre-surfaced booking
src/agent/system-prompt.ts                # optional context line after the dated line
src/agent/tool-schemas.ts, tool-registry.ts # confirm_attendance
src/messages.ts                           # reminder, attendance reply, unconfirmed notice
src/composition.ts                        # template env + fail-fast
prompts/system/v003.md, prompts/CHANGELOG.md
evals/lib/* (seed reminderSentAt/createdAt, category reminder), evals/cases/rem-*.json
```

## Complexity Tracking
| Item | Why needed | Simpler alternative rejected because |
|---|---|---|
| Deterministic "sim" fast path | SC-702 (zero model calls), cost and latency of the most common answer | sending "sim" to the model costs a call per reminder and adds a failure mode for the simplest case |
| Template argument on the port | the official channel cannot start a conversation without a template (FR-707) | a second port method duplicates the send path for one parameter |
