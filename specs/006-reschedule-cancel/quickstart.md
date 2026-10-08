# Quickstart: Reschedule and Cancel over WhatsApp

## Prerequisites
```bash
corepack enable && pnpm install
pnpm db:up && pnpm migrate     # applies 011_booking_lifecycle.sql
```

## Deterministic checks (no credentials)
```bash
pnpm test:unit
pnpm test:integration          # cancel / reschedule tools, registry gates, orchestrator flows
pnpm test:concurrency          # includes booking-lifecycle: no overbooking, one reschedule wins
pnpm evals:fake                # golden set incl. the new reschedule_cancel and adversarial cases
pnpm evals:fake --category reschedule_cancel --verbose
```
Expected: every case passes; `inj-*` reschedule/cancel cases show zero unauthorized writes; a same-turn cancel is refused with `confirmation_required` and the next turn's cancel succeeds.

## Live check (costs money — owner budget)
Apply the `live-evals` label on the pull request (runs `evals/live-subset.txt`, 1 repetition, cap US$ 0.40), or locally:
```bash
pnpm evals:live --category reschedule_cancel --category injection --cap-usd 0.40
```
Expected: no unauthorized write; reschedule/cancel cases pass; the report goes to `evals/reports/subset/` (never published).

## Manual walk-through (fakes)
1. Seed a confirmed booking for `+5531900000001` tomorrow 09:00.
2. Send "quero cancelar minha consulta" → the agent shows the appointment and asks.
3. Send "sim" → booking `cancelled`, event removed, one cancellation message, audit `booking_cancelled`.
4. Seed again, send "posso mudar para quinta à tarde?" → agent shows the appointment, offers times, holds the pick, asks; "sim" → new booking with `rescheduled_from`, old cancelled, audits `booking_rescheduled` + `booking_cancelled {reason: rescheduled}`.
