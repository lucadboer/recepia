# Quickstart: Appointment Reminders and Attendance Confirmation

```bash
pnpm migrate                      # applies 012_reminders.sql
pnpm test:integration             # jobs, fast path, precedence, interplay with 006 and opt-out
pnpm evals:fake --category reminder --verbose
```
Expected: one reminder per qualifying booking even with concurrent job runs; "sim" confirms attendance with 0 model calls; a reply that is not a plain "sim" reaches the model with the booking in context; unanswered reminders produce one reception notice 3 h before.

Configuration: `REMINDERS_ENABLED` (default on), `REMINDER_LEAD_HOURS` (24), `UNCONFIRMED_NOTICE_LEAD_HOURS` (3); official channel: `WHATSAPP_REMINDER_TEMPLATE`, `WHATSAPP_REMINDER_TEMPLATE_LANG` (`pt_BR`). The template must be approved in Meta's WhatsApp Manager (owner task) with three body parameters: patient name, appointment type, date and time.

Live (costs money): label `live-evals` on the PR (`evals/live-subset.txt`, cap US$ 0.50).
