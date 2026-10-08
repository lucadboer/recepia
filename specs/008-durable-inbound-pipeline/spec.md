# Feature Specification: Durable Inbound Message Pipeline

**Feature Branch**: `008-durable-inbound-pipeline`

**Created**: 2026-10-08

**Status**: Draft

**Input**: User description: "Reliability at the edge: today the webhook acknowledges a patient message before processing it and keeps it only in memory, so a crash or a restart at the wrong moment loses it — the provider will not resend what it already saw acknowledged. Store every accepted message before acknowledging it, process each patient's messages in order and one at a time across workers, retry failures with backoff and hand a message that keeps failing to reception, keep one patient from flooding the queue, and prove it with a load test that kills the process mid-run."

> Spec artifacts are in English (author preference). Builds on 002 (webhook hardening, per-phone serialization, optimistic concurrency), 005 (tracing, retention) and the booking features 001/006/007, whose idempotency (provider message id per conversation, idempotent tools) remains the second line of defence. This feature changes no patient-facing behaviour; it changes what happens when things break. Owner decision (from the portfolio plan): a hand-rolled Postgres queue (`FOR UPDATE SKIP LOCKED`, the same pattern as the outbox), no queue library.

## Clarifications

### Session 2026-10-08

- Q: What does the provider get when the database is down? → A: A failure answer (503) so it retries later; a message is acknowledged only after it is stored (default taken by the agent). The unofficial channel may not retry; that limitation is documented.
- Q: How many attempts before a message is handed to reception? → A: 5 (backoff 2 s, 10 s, 30 s, 2 min, 10 min with ±20 % jitter); then the message is marked dead, audited, and reception gets one hand-off (default taken by the agent).
- Q: What happens to a patient who sends a burst of messages? → A: Up to 20 unfinished messages per phone are queued; beyond that new ones are stored as dropped (kept for the audit trail, not processed) and a warning is logged — no reply, so a loop cannot turn into a message storm (default taken by the agent).
- Q: How long is message text kept? → A: Only until the message is processed (then it is cleared); finished rows are purged with the existing 90-day retention (owner's LGPD decision, 005).

## User Scenarios & Testing *(mandatory)*

### User Story 1 — No acknowledged message is ever lost (Priority: P1)

As a patient, when I send a message and the service restarts or crashes before answering, my message is still answered when it comes back — I never have to repeat myself because of an outage I cannot see.

**Why this priority**: losing a "sim" to a confirmation or a reschedule request is exactly the silent failure the product cannot afford.

**Independent Test**: send messages through the webhook, kill the process at random moments three times and restart it; every message that received an acknowledgment is processed, none is left half-processed, and no booking is duplicated.

**Acceptance Scenarios**:

1. **Given** a verified patient message, **When** it is acknowledged, **Then** it has already been stored durably.
2. **Given** the database is unavailable, **When** a message arrives, **Then** it is not acknowledged as received (the provider can retry).
3. **Given** a worker died while processing a message, **When** its lease expires, **Then** another worker processes it, and the patient sees the effect once.
4. **Given** the same message is delivered twice, **When** both deliveries arrive, **Then** it is stored and processed once.

---

### User Story 2 — Each patient's messages in order, one at a time (Priority: P1)

As a patient who sends "quero marcar" and then "amanhã cedo" in quick succession, my messages are handled in the order I sent them and never two at once, even when the service runs several workers — while other patients are served in parallel.

**Why this priority**: out-of-order or concurrent turns for the same patient corrupt the conversation; today this is guaranteed only inside one process.

**Independent Test**: 200 messages over 10 phones with 4 workers; for every phone the order the agent saw equals the order sent, and no two turns of a phone overlap.

**Acceptance Scenarios**:

1. **Given** several queued messages of one phone, **When** workers run, **Then** only the oldest unfinished one is processed, and the next only after it finished.
2. **Given** messages of different phones, **When** workers run, **Then** they are processed concurrently up to the configured concurrency.

---

### User Story 3 — A message that keeps failing goes to reception (Priority: P2)

As reception, when a patient's message cannot be processed after several attempts, I get one hand-off naming the patient, instead of the message being retried forever or silently dropped.

**Independent Test**: make processing fail every time; after the configured attempts the message is dead, audited, reception has one notice, and the next message of that phone is processed.

**Acceptance Scenarios**:

1. **Given** processing fails, **When** attempts remain, **Then** the message is retried after a growing, jittered delay.
2. **Given** the last attempt fails, **When** it is recorded, **Then** the message is dead, audited and handed to reception in one step, and the phone's queue moves on.

---

### User Story 4 — One patient cannot flood the queue (Priority: P3)

As the operator, a single phone that sends dozens of messages in a burst cannot grow the queue without bound.

**Independent Test**: enqueue 25 messages for one phone; 20 are queued, 5 are stored as dropped and logged; other phones are unaffected.

---

### Edge Cases

- A message is acknowledged, then the process dies before the worker claims it → processed after restart.
- A worker finishes the turn but dies before marking it done → the lease expires, the message is re-run; the conversation's processed-id dedupe and the idempotent tools make the second run a no-op.
- A slow turn outlives the lease → the worker extends its lease while running (heartbeat); a reclaimed message whose original worker comes back cannot be marked done by it.
- Shutdown while turns run → in-flight turns are drained within the existing budget; queued messages wait for the next start.
- A dead message must not block the phone's later messages.

## Requirements *(mandatory)*

- **FR-801**: Every verified inbound message MUST be stored (unique per provider and provider message id) before the webhook acknowledges it; when it cannot be stored, the webhook MUST answer with a retryable failure.
- **FR-802**: A redelivered message MUST be stored and processed once.
- **FR-803**: Messages MUST be processed in arrival order per phone with at most one in flight per phone; different phones MUST be processed concurrently up to a configurable limit.
- **FR-804**: A message whose worker stopped MUST be reclaimed after a lease; a running worker MUST extend its lease; only the current lease holder can finish a message.
- **FR-805**: A failed attempt MUST be retried with a jittered, growing delay; after the last attempt the message MUST be marked dead, audited and handed to reception in one transaction, and the phone's later messages MUST proceed.
- **FR-806**: More than 20 unfinished messages for one phone MUST be stored as dropped and logged, not processed.
- **FR-807**: A processed message's text MUST be cleared; finished messages MUST be purged by the 90-day retention job.
- **FR-808**: The processing trace of a message MUST be linked to the trace of the webhook request that stored it.
- **FR-809**: Shutdown MUST drain in-flight turns within the existing budget and leave queued messages for the next start.
- **FR-810**: A load test with repeated hard kills MUST show zero lost acknowledged messages, per-phone order preserved, zero overbooking and zero duplicate bookings; it runs in CI on demand and nightly.

### Key Entities

- **Inbound message**: provider, provider message id, phone, text (until processed), status (pending, processing, done, dead, dropped), attempts, next attempt time, lease (holder and expiry), last error, trace link, received and processed times.

## Success Criteria *(mandatory)*

- **SC-801**: 0 acknowledged messages lost across 3 random hard kills in the chaos test.
- **SC-802**: 100 % of phones keep their message order under 4 concurrent workers; 0 overlapping turns of one phone.
- **SC-803**: 0 overbooking and 0 duplicate confirmed bookings in the load and chaos tests.
- **SC-804**: A permanently failing message reaches reception exactly once after the configured attempts.
- **SC-805**: The webhook acknowledges a stored message within the existing perf-smoke p95 budget.

## Assumptions

- The provider retries on a failure answer (the official channel does; the unofficial one may not — documented).
- A single Postgres is the queue; no external broker.
- Patient replies sent directly inside a turn (not through the outbox) are unchanged; making them durable is out of scope.
