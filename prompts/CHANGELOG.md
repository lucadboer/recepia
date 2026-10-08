# System prompt changelog

The agent's system prompt is a versioned artifact: `prompts/system/vNNN.md` is the static block
(placeholders `{{routine_types}}` and `{{tool_names}}` are rendered from code); the loader appends
one dated line per turn (today's weekday/date/time/timezone). The version id recorded on every
model call, in audit payloads of model-initiated writes and in every eval report is
`vNNN+<sha256(file)[:7]>`, so any edit — even one character — is traceable.

Rules: a new file (`v002.md`, …) for a change in instructions; an entry here for every version
(the loader refuses to start without it); a baseline update in the same PR when the eval numbers
move (feature 004).

## v003 — 2026-10-08
- Appointment reminders (feature 007, SPEC.md US2): when the context line says the patient is
  answering a reminder, the appointment was already shown; `confirm_attendance` with the context's
  `bookingId` when the patient will come; cancel/reschedule keep the 006 confirmation round trip.
  Attendance confirmation no longer goes to reception. One new style example (reminder reply).
  After the PR live run: a clear "pode cancelar" for an appointment already shown is the
  confirmation (no second question); "sim, mas preciso mudar" is a change request, not an
  attendance confirmation (the registry also refuses it: `change_requested`).

## v002 — 2026-10-08
- Cancel and reschedule (feature 006, SPEC.md US3): start with `find_my_booking`, show the
  appointment and ask; `cancel_booking` / `reschedule_booking` only after the patient confirms in a
  later message (the registry enforces it structurally: `not_surfaced`, `confirmation_required`);
  a reschedule goes through `get_availability` → `hold_slot` for the same appointment type and the
  old appointment stands until it completes; none / several appointments or attendance
  confirmation go to reception. One new style example (cancellation).

## v001 — 2026-10-06
- Initial artifact: the static block moved verbatim from `src/agent/system-prompt.ts` (pilot copy
  accepted by the owner, T220/T221). Defense-in-depth wording only; the structural guarantees are
  the gates in `tool-registry.ts` and the orchestrator.
