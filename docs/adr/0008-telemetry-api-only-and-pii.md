# ADR 0008 — Telemetry through the OpenTelemetry API only; no personal data in logs or traces

- Status: accepted (feature 005, 2026-10-07)

## Context
The agent had a handful of plain log lines; a surprising turn could not be reconstructed and the
cost of a conversation was unknown. Telemetry is also the first thing shipped to third parties, and
this system handles patients' phone numbers and health-adjacent messages (LGPD, constitution V).

## Decision
- **API in the code, SDK at the edge.** Business code depends only on `@opentelemetry/api`.
  `src/telemetry/register.ts` (loaded with `node --import`) registers a `NodeTracerProvider`, an
  OTLP/HTTP batch exporter and the `pg` instrumentation **only when an OTLP endpoint is configured**;
  otherwise the API is a no-op. Tests register an in-memory provider when they assert on spans.
- **Span model.** One root span per patient message, a turn span, GenAI-semconv `chat` spans per
  model call (usage incl. cache tokens, finish reason, provider, prompt version, estimated cost),
  `execute_tool` spans with the outcome and the guardrail that rejected a call, and `outbox.dispatch`
  spans **linked** to the span that enqueued the message (W3C `traceparent` stored on the outbox row)
  — links instead of one long trace, because deliveries can be retried for ~40 minutes.
- **No content, no phones.** Patients are a keyed pseudonym (HMAC with an operator secret) plus a
  masked phone; provider message ids are keyed references too (a WhatsApp `wamid` encodes the phone);
  message text, model output and names are never recorded; tool arguments are reduced to validated
  non-personal fields; spans carry error types, never messages; logs drop content keys and pass every
  string through a masking backstop; a redacting exporter is the last line for third-party
  instrumentations. Automated scans over real conversations enforce it.
- **Logs** are pino JSON with the active trace/span ids; no log transport in the process.

## Consequences
- Any OTLP backend works (Jaeger locally via a compose profile); nothing is vendor-specific.
- Zero overhead when telemetry is off; with it on, the perf smoke's p95 budget is measured with a
  real exporter in CI.
- A trace shows *what* happened (which tool, which guardrail, how many tokens) but never *what was
  said* — debugging content needs the conversation state in the database, under its own access
  rules.
- The masking backstop deliberately ignores digit runs glued to letters (identifiers); a phone
  written without separators inside a word would escape it — the content-key rules are the primary
  guard, the backstop is the second line.
