# Research: Appointment Reminders and Attendance Confirmation

## R1 — Where reminder state lives
- **Decision**: two nullable columns on `booking` (`reminder_sent_at`, `unconfirmed_notice_at`) set in the same transaction as the outbox row and the audit entry.
- **Rationale**: one reminder per booking; a separate table adds a join and a lifecycle for no extra information. A moved appointment is a new booking row (006), so it gets its own state naturally.
- **Alternatives**: `booking_reminder` table (rejected: YAGNI); deriving from the outbox (rejected: the outbox is purged after 90 days).

## R2 — Job claims and timing
- **Decision**: `SELECT … FOR UPDATE OF b SKIP LOCKED LIMIT 50` over `status = 'confirmed' AND reminder_sent_at IS NULL AND start_ts > now + NOTICE_LEAD AND start_ts <= now + REMINDER_LEAD AND created_at <= start_ts - REMINDER_LEAD` with the latest consent row (`LATERAL … ORDER BY seq DESC LIMIT 1`) equal to `opted_in`; per row stamp + outbox + audit, one transaction for the batch. Unconfirmed notice: `status = 'confirmed' AND reminder_sent_at IS NOT NULL AND unconfirmed_notice_at IS NULL AND start_ts > now AND start_ts <= now + NOTICE_LEAD`.
- **Rationale**: SKIP LOCKED + the stamp make concurrent runs safe (SC-701); the outbox dedupe key is a second guard.
- **Defaults**: `REMINDER_LEAD_HOURS = 24`, `UNCONFIRMED_NOTICE_LEAD_HOURS = 3`, interval 15 min, `REMINDERS_ENABLED = true`.

## R3 — Reply handling and precedence
- **Decision**: order = dedupe → opt-out → handed-off → consent capture (if it consumed the message, stop) → **fast path** (exactly one pending reminder read from the database, not awaiting consent, no live hold in this conversation, whole message strictly affirmative) → triage → model with a context line. `isStrictAffirmative` accepts only a short, negation-free affirmation ("sim", "sim!", "confirmo", "pode confirmar", "confirmado", "ok", "👍", "estarei lá", the button text) and nothing else.
- **Rationale**: the common answer costs nothing and cannot be misread; everything else keeps the model and the 006 gates.
- **Alternatives**: always the model (cost, latency); a broad affirmative matcher ("sim, mas…" would confirm).

## R4 — The model's context
- **Decision**: the system prompt gets one more dynamic line after the dated line: "Lembrete enviado: consulta de <tipo> em <label> (bookingId <id>). O paciente está respondendo a esse lembrete." The booking is recorded in `surfacedBookings` with the current turn, so `confirm_attendance` is allowed now and `cancel_booking`/`reschedule_booking` need the 006 round trip.
- **Rationale**: the reminder was sent by a job, not appended to the conversation history; the cached static prefix stays byte-identical.

## R5 — Templates and buttons
- **Decision**: `MessagingPort.sendMessage(to, body, template?)` with `template = { name, language, params[] }`; the outbox row stores it (`template jsonb`). Cloud adapter → `type: "template"` with one body component of text parameters (newlines/tabs collapsed to spaces, a Cloud rule); Evolution → text body. Cloud parser maps `type: "button"` (`button.text`) and `type: "interactive"` (`button_reply.title`) to the message text. `WHATSAPP_REMINDER_TEMPLATE` / `_LANG` (default `pt_BR`); Cloud + reminders on + no template → startup error.

## R6 — Interplay with 006 and opt-out
- **Decision**: cancel and reschedule cancel a still-pending `appointment_reminder:<id>` of the booking they release, in their transaction; opt-out already cancels every pending row to the patient. The fast path never runs for a handed-off conversation.

## R7 — Evaluation and live spend
- **Decision**: new category `reminder`; seeds gain `reminderSentAt` and `createdAt` per booking. Cases: `rem-01` plain "sim" (llmCalls 0), `rem-02` "sim, mas preciso mudar", `rem-03` "não vou poder ir" → cancel after confirmation, `rem-04` reschedule request, `rem-05` "sim" while awaiting consent, `rem-06` "me tira da lista" (opt-out), `rem-07` "me tira dessa consulta" (not an opt-out), `inj-14` reply naming another phone. `resched-04` (attendance) becomes a real flow. Live: labelled subset (~23 cases × 1, cap US$ 0.50); the single full re-baseline follows after merge (cap US$ 0.80).
