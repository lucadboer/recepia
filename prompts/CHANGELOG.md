# System prompt changelog

The agent's system prompt is a versioned artifact: `prompts/system/vNNN.md` is the static block
(placeholders `{{routine_types}}` and `{{tool_names}}` are rendered from code); the loader appends
one dated line per turn (today's weekday/date/time/timezone). The version id recorded on every
model call, in audit payloads of model-initiated writes and in every eval report is
`vNNN+<sha256(file)[:7]>`, so any edit — even one character — is traceable.

Rules: a new file (`v002.md`, …) for a change in instructions; an entry here for every version
(the loader refuses to start without it); a baseline update in the same PR when the eval numbers
move (feature 004).

## v005 — 2026-11-09
- Voice (owner feedback on the README demo: "achei a IA meio rude"). The live v004 replies were
  correct but stiff ("Excluindo a terça, os horários livres após as 16h são estes:", "Fica
  assim:") and once pushy ("A reserva fica garantida por alguns minutos, então me responda
  logo."). New "Voice" section: warm, natural, professional WhatsApp pt-BR; acknowledge the
  request; use the name of the person the appointment is for; one to three short paragraphs; WhatsApp
  formatting only (*single asterisks*, bold for days and times); never narrate internal steps;
  never rush the patient or mention the hold timer unless asked or expired; at most one emoji,
  none in sensitive moments; a kind sentence and a next step when something does not work out.
- Sample phrasing rewritten in that voice (times grouped by day instead of a numbered list; no
  "(responda SIM)" on the booking confirmation — the model reads "pode", "isso", "sim").
  Instructions and gates are unchanged.

## v004 — 2026-11-09
- Model-facing text in English (ADR 0012): the instructions in this file, the dated line and the
  reminder context line (`src/agent/system-prompt.ts`), the tool descriptions
  (`src/agent/tool-schemas.ts`), the registry's gate messages and the failed-tool feedback
  (`src/agent/tool-feedback.ts`). The instructions are unchanged in substance. New: "always write to
  the patient in Brazilian Portuguese, whatever the language of these instructions or of the
  patient's message". The sample phrasing stays in Portuguese (it is the register the replies
  should have), and so does everything the patient or the reception reads. The dated line now
  gives the date in ISO form (`2026-07-15`), which an English instruction cannot misread as
  month/day.

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
