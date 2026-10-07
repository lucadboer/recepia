# Feature Specification: Observability and Cost Control for the Booking Agent

**Feature Branch**: `005-observability-and-cost`

**Created**: 2026-10-07

**Status**: Draft

**Input**: User description: "Make the WhatsApp booking agent operable in production: one end-to-end trace per patient message (receipt, the turn, every model call with model/tokens/finish reason/prompt version, every tool call and its outcome, database work, and the later delivery of the committed message), structured logs without personal data and correlated with traces, liveness/readiness checks, token usage and estimated cost per conversation with a per-conversation budget that hands off to reception when exceeded, prompt caching of the stable prefix, an optional fallback model provider for transient outages, and the LGPD retention job decided by the owner (purge conversation state and delivered messages after 90 days of inactivity, keep the consent ledger and the audit log)."

> Spec artifacts are in English (author preference); patient-facing strings stay in Brazilian Portuguese. Builds on features 001 (deterministic booking tools), 002 (conversational orchestration) and 004 (evaluation harness, which measures cost and caching). This feature adds **one patient-facing behaviour** — the budget hand-off — and otherwise makes the existing behaviour observable, cheaper and bounded.

## Clarifications

### Session 2026-10-07

- Q: What estimated-cost budget per conversation triggers the hand-off to reception? → A: US$ 0.25 per conversation (≈ 8× a full booking conversation), configurable.
- Q: Which secondary (fallback) model provider? → A: Ship a generic adapter for the open chat-completions protocol plus the fallback logic, tested with simulated providers; it stays off until the owner configures a provider and credential (no spend now).
- Q: The audit log is kept forever (T222) and escalation rows carry the raw patient text (`context`) and a short excerpt (`summary`) — minimise them? → A: Keep as is (owner, 2026-10-07, raised in the PR #9 review). The 90-day purge covers conversation state and delivered messages only.
- Q: How is the patient identified in traces and logs without the phone? → A: A keyed pseudonym (one-way hash of the phone with an operator secret) for correlation plus the masked phone (last 4 digits) for humans; without the secret, a random per-process secret is used and a warning is logged (pseudonyms then change on restart).

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Follow one patient message end to end (Priority: P1)

As the operator, when a patient says "I never got my confirmation" or reception asks why a conversation was handed off, I want to find the single trace of that message and see every step: the message arriving, the turn that handled it, each model call (which model, how many tokens, why it stopped, which prompt version), each tool call and its outcome (done, rejected by which guardrail, failed), the database work, and the later delivery of the message that turn committed — without the patient's phone number or message text appearing anywhere in the trace.

**Why this priority**: today the only signal is a handful of plain log lines; a failed or surprising turn cannot be reconstructed. Tracing is the base the other stories report into.

**Independent Test**: with a local trace viewer running, send one booking conversation through the webhook; each inbound message produces exactly one trace with the expected steps, the confirmation delivery appears linked to the turn that committed it, and searching the exported data for the patient's phone or message text finds nothing.

**Acceptance Scenarios**:

1. **Given** a trace collector is configured, **When** a patient message is processed, **Then** one trace contains the receipt, the turn, every model call (model, input/output/cache tokens, finish reason, prompt version, provider), every tool call (name, outcome, guardrail that rejected it if any) and the database statements, with timings.
2. **Given** a turn committed a confirmation or a reception notice, **When** the delivery happens (in the same turn or later by the background dispatcher), **Then** the delivery step is linked to the trace of the turn that committed it.
3. **Given** a model call or a tool fails, **When** the trace is inspected, **Then** the failing step is marked as an error with its error type, and the turn's outcome is unchanged by tracing.
4. **Given** no collector is configured, **When** the agent runs, **Then** it behaves exactly as before, with no errors and no measurable overhead.

---

### User Story 2 — Logs that are safe to keep and easy to correlate (Priority: P1)

As the operator, I want every log line to be structured (level, time, event, conversation pseudonym, message id, and the trace it belongs to) so I can filter one conversation and jump to its trace, and I want a guarantee that no log line ever contains a full phone number or the text a patient wrote. I also want the process to answer "are you alive?" and "can you serve?" so a platform can restart or hold traffic from it.

**Why this priority**: logs are what gets shipped to third-party services first; one leaked phone number in a log pipeline is an LGPD incident (constitution V).

**Independent Test**: run the full automated suite and the deterministic evaluation with logs captured; no captured line contains a full fixture phone or a fixture message text; every line emitted inside a turn carries the trace id of that turn; the liveness check answers while the database is down and the readiness check does not.

**Acceptance Scenarios**:

1. **Given** any component logs an event about a patient, **When** the line is written, **Then** the phone appears only masked (last 4 digits) or as a stable pseudonym, and message bodies never appear.
2. **Given** an error whose message embeds a phone number (e.g. a concurrency conflict), **When** it is logged, **Then** the phone in the message is masked as well.
3. **Given** the process is running, **When** the liveness endpoint is called, **Then** it answers OK without touching the database; **When** the readiness endpoint is called, **Then** it answers OK only if the database answers.

---

### User Story 3 — A conversation cannot run up an unbounded bill (Priority: P1)

As the owner (paying for the model per token), I want the token usage and estimated cost of every model call to accumulate per conversation, a per-conversation budget after which the agent stops calling the model and hands the patient to reception, and the stable part of every request (tool definitions and static instructions) cached so repeated calls within a conversation cost a fraction of the first.

**Why this priority**: the agent loop is bounded by iterations, not by money; a stuck or adversarial conversation could keep spending. Caching is the largest single cost lever for a tool loop that re-sends the same prefix 3–7 times per message.

**Independent Test**: with a scripted model reporting known token counts and a small budget, a conversation that reaches the budget is handed off before the next model call with the deterministic pt-BR hand-off reply and an audit row naming the budget; with the real model, every conversation with two or more model calls reports cache-read tokens greater than zero.

**Acceptance Scenarios**:

1. **Given** a conversation whose accumulated estimated cost has reached the budget, **When** the next model call would be made, **Then** no model call is made, reception is notified once with the reason "budget exceeded", the patient receives the hand-off reply, and the conversation is handed off.
2. **Given** a model call completes, **When** the conversation state is saved, **Then** it carries the accumulated tokens (input, output, cache read, cache write), the estimated cost and the model(s) used.
3. **Given** several model calls in one conversation, **When** the second and later calls are made, **Then** the stable prefix is read from the provider's cache (cache-read tokens > 0) and the evaluation report shows the cache hit ratio.
4. **Given** the configured model has no price in the pricing table, **When** the service starts, **Then** it refuses to start (the budget would be unenforceable).

---

### User Story 4 — Keep answering when the primary model provider has a transient outage (Priority: P2)

As the owner, I want an optional secondary model provider that is used only when the primary fails transiently (timeout, rate limit, server error, connection failure) — never when the primary refuses, rejects the request as invalid, or rejects the credentials — and I want every model call to record which provider and model served it, so I can measure the secondary with the evaluation harness before relying on it.

**Why this priority**: a provider outage today means every patient message fails; a fallback turns an outage into degraded service. It is P2 because it needs a second provider account (owner's choice and cost) and the primary's availability is already high.

**Independent Test**: with a primary that fails with a timeout and a scripted secondary, every turn completes through the secondary and records it; with a primary that refuses or rejects the request, the secondary is never called.

**Acceptance Scenarios**:

1. **Given** a secondary provider is configured and the primary times out, is rate-limited, returns a server error or cannot be reached, **When** a model call is made, **Then** the same request is sent to the secondary and its answer is used; the call is recorded with the secondary's provider and model.
2. **Given** the primary refuses, rejects the request as invalid or rejects the credentials, **When** a model call is made, **Then** the secondary is not called and the existing behaviour applies (refusal → hand-off; other errors fail loudly).
3. **Given** no secondary is configured, **When** the primary fails, **Then** behaviour is exactly as today.
4. **Given** the secondary provider credential, **When** the live evaluation is pointed at the secondary, **Then** the report states the provider and model it measured.

---

### User Story 5 — Personal data is not kept longer than needed (Priority: P2)

As the data controller, I want conversation state and delivered/terminal messages purged after 90 days without activity (owner decision 2026-10-06, task T222), while the consent ledger and the audit log are kept, each purge audited with counts only, and a dry run that shows what would be purged.

**Why this priority**: required by the LGPD minimisation principle and decided by the owner; it is P2 because no production data exists yet.

**Independent Test**: seed conversations and messages with activity older and newer than 90 days; the purge removes exactly the old conversation states and old terminal messages, keeps every pending message, consent row and audit row, and writes one audit row with the counts; the dry run reports the same counts and deletes nothing.

**Acceptance Scenarios**:

1. **Given** a conversation inactive for more than 90 days, **When** the daily retention job runs, **Then** its conversation state is deleted and one audit row records how many states and messages were purged (no phones, no ids).
2. **Given** a message still pending delivery, **When** the job runs, **Then** it is never purged regardless of age.
3. **Given** the dry-run command, **When** it runs, **Then** it reports the counts and deletes nothing.

---

### Edge Cases

- Trace collector unreachable or slow: telemetry is dropped in the background; patient turns are never delayed or failed by telemetry.
- A model call made by the evaluation harness or the live tests: traced like production when a collector is configured; otherwise no telemetry.
- Usage not reported (scripted model, provider without usage): cost counts as zero for that call; the budget only counts what was reported, and the evaluation report states it.
- The budget is reached in the middle of a turn after the turn already committed a confirmation: the booking stands and its confirmation is delivered; no further model call is made and the turn ends normally (the conversation is complete, so reception is not bothered).
- A conversation resets after completion (feature 002 FR-212): its usage and budget start again at zero, the previous totals stay in the history of the audit trail (booking/escalation rows) only.
- The secondary provider cannot read the primary's reasoning blocks: they are not sent to it; switching providers within a turn never fails the request because of them.
- The secondary provider also fails: the turn fails exactly as a primary failure does today (no third attempt).
- Retention job races an inbound message for a conversation about to be purged: the conversation was active again, so losing the old state is acceptable (it restarts fresh, dedupe of old message ids is not needed after 90 days).
- A phone number embedded in free text logged by a third-party library: masked by the log pipeline's pattern-based backstop.
- Health checks must not be logged as webhook traffic, must not require the webhook secret, and must not reveal configuration.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-501 — One trace per message**: Every inbound patient message MUST produce exactly one trace covering its receipt, the conversation turn, every model call, every tool call and the database statements, with timings and error status.
- **FR-502 — Model call details**: Every model-call step MUST record the provider, the requested and served model, input/output/cache-read/cache-write tokens, the finish reason, the prompt version and the estimated cost, using the industry's standard attribute names for generative-AI calls where they exist.
- **FR-503 — Tool call details**: Every tool-call step MUST record the tool name and its outcome (`ok`, `rejected` with the guardrail that rejected it, or `error` with the error type); tool arguments MAY be recorded only for non-personal fields (appointment type, slot start), never names or phones.
- **FR-504 — Deferred delivery link**: A message committed by a turn MUST carry a reference to that turn's trace so its delivery step — immediate or by the background dispatcher, including retries and dead-lettering — is linked to it.
- **FR-505 — No personal data in telemetry**: Traces and logs MUST NOT contain a full phone number or any patient or model message text. Patients are identified by a masked phone (last 4 digits) and a keyed pseudonym that cannot be reversed without the operator's secret (decided 2026-10-07); when the secret is not configured, a random per-process secret is used and a warning is logged. A pattern-based backstop masks phone numbers in any logged string.
- **FR-506 — Vendor-neutral export**: Telemetry MUST be exported with the open standard protocol to any compatible collector, MUST be disabled (no-op) when no collector is configured, and MUST never block or fail a patient turn. A local collector and viewer MUST be available as an optional development profile.
- **FR-507 — Structured logs**: All application output MUST be structured log lines with level, time, event name and, inside a traced operation, the trace and span ids; the minimum level is configurable; every existing plain console output is replaced.
- **FR-508 — Health endpoints**: The service MUST expose a liveness endpoint (process up, no dependencies) and a readiness endpoint (database reachable), unauthenticated, revealing no configuration and not logged per request.
- **FR-509 — Usage accounting**: Every model call's token usage and estimated cost MUST accumulate per conversation in the conversation state (tokens by kind, estimated cost, calls, models used) and reset when the conversation starts fresh.
- **FR-510 — Per-conversation budget**: Before every model call the agent MUST compare the conversation's accumulated estimated cost with the configured budget (default US$ 0.25, decided 2026-10-07); at or above it, no model call is made and the conversation is handed off to reception with reason `budget_exceeded`, a deterministic pt-BR reply and an audit row with the accumulated cost and the budget — except when the turn already committed a confirmation, which then owns the reply and ends the turn normally.
- **FR-511 — Prompt caching**: Every model request MUST mark its stable prefix (tool definitions and static instructions) as cacheable, and the per-turn context (date/time) MUST be placed so that it does not invalidate the cached prefix; cache read/write tokens are recorded (FR-502) and the evaluation report shows the cache hit ratio.
- **FR-512 — Single pricing table**: The dated pricing table MUST be the single source for the runtime budget and the evaluation harness; the service MUST refuse to start when a configured model has no price.
- **FR-513 — Fallback provider**: An optional secondary provider speaking the widely used open chat-completions protocol MUST be used only when the primary fails transiently (timeout, rate limit, server error, connection failure) and never on refusal, invalid request or authentication error; the primary MUST have a bounded per-call timeout so fallback can happen; a failure of both fails the turn as today.
- **FR-514 — Measurable secondary**: The live evaluation MUST be able to target the secondary provider and record provider and model in its report.
- **FR-515 — Retention**: A daily job MUST delete conversation states with no activity for more than 90 days and delivered, failed or cancelled messages older than 90 days, MUST never delete pending messages, the consent ledger or the audit log, MUST write one audit row per run with counts only, and MUST offer a dry run.
- **FR-516 — Overhead**: With telemetry enabled, the existing performance smoke MUST stay within its latency budget; with telemetry disabled there MUST be no behavioural change.

### Key Entities

- **Trace / Step**: one patient message's end-to-end record and its timed steps (receipt, turn, model call, tool call, database statement, delivery), with attributes and error status.
- **Conversation Usage**: tokens by kind, estimated cost, number of model calls and models/providers used, accumulated per conversation.
- **Budget**: the per-conversation estimated-cost limit (default US$ 0.25) that triggers the hand-off.
- **Pricing Table**: the dated per-model token prices shared by the runtime budget and the evaluation harness.
- **Provider**: primary (Anthropic) or secondary (any open chat-completions endpoint) that served a model call.
- **Patient Pseudonym**: masked phone and keyed hash used in telemetry instead of the phone.
- **Retention Run**: one execution of the purge with its counts (audited).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-501**: For a booking conversation sent through the webhook, 100 % of inbound messages produce exactly one trace containing the receipt, the turn, every model call, every tool call and the linked delivery; demonstrated once with a captured trace image in the documentation.
- **SC-502**: Zero full phone numbers and zero patient message texts appear in the logs and traces captured while running the full automated suite and the deterministic evaluation (checked automatically).
- **SC-503**: 100 % of conversations whose accumulated cost reaches the budget are handed off before the next model call (scripted test), and in the live evaluation no conversation exceeds the budget by more than one model call.
- **SC-504**: In the live evaluation, every conversation with two or more model calls reports cache-read tokens greater than zero, and the report shows both the estimated cost and what the same tokens would have cost without caching (computed from the same run — no extra paid run).
- **SC-505**: With the primary failing transiently (simulated), 100 % of turns complete through the secondary; with refusals or invalid requests, 0 calls reach the secondary.
- **SC-506**: The retention job removes 100 % of eligible rows and 0 pending messages, consent rows or audit rows (test), and the dry run deletes nothing.
- **SC-507**: The performance smoke's p95 with telemetry enabled stays within the existing budget (+10 %).

## Assumptions

- No production traffic exists; telemetry is exercised locally (development profile) and in automated tests with in-memory exporters. Live model checks are kept minimal because the owner's model credit is limited (2026-10-07): a single short live call validates caching, and the full live evaluation runs once, after caching, under a hard spend cap.
- The secondary provider is any service speaking the open chat-completions protocol with tool calling; which one (and its credential) is the owner's choice (decided 2026-10-07: generic adapter now, provider later) — the feature ships with the adapter, simulated-provider tests and documentation, and the live check of the secondary waits for the credential.
- Metrics dashboards, alerting and log shipping infrastructure are out of scope; steps carry the numbers needed to derive them later.
- The retention period (90 days) and what is kept (consent ledger, audit log) were decided by the owner on 2026-10-06 (feature 002, T222).
- The default budget (US$ 0.25 per conversation) is about eight times the expected cost of a full booking conversation and is configurable.
