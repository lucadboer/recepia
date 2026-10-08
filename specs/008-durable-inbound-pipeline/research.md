# Research: Durable Inbound Message Pipeline

## R1 — Ack after durable write
- **Decision**: verify → parse → insert all messages of the request in one transaction → 200; insert failure → 503. Statuses (Cloud) stay log-only.
- **Rationale**: an acknowledgment is a promise; the provider stops retrying once it sees 200.
- **Alternatives**: ack first and store asynchronously (the current gap).

## R2 — Claim: FIFO per phone, one in flight per phone, crash recovery
- **Decision**:
  ```sql
  UPDATE inbound_message SET status='processing', locked_by=$w, locked_until=$now+$lease, attempts=attempts+1
  WHERE id = (
    SELECT m.id FROM inbound_message m
    WHERE ((m.status='pending' AND m.next_attempt_at <= $now) OR (m.status='processing' AND m.locked_until < $now))
      AND NOT EXISTS (SELECT 1 FROM inbound_message o WHERE o.phone=m.phone AND o.id < m.id AND o.status IN ('pending','processing'))
    ORDER BY m.id LIMIT 1 FOR UPDATE SKIP LOCKED)
  RETURNING *;
  ```
  plus: a pending row is not claimable while its phone has a `processing` row with a live lease (`NOT EXISTS … o.status='processing' AND o.locked_until >= $now` for any id).
- **Rationale**: one statement, no session state; `bigserial id` gives arrival order; the conversation CAS stays as the backstop.
- **Alternatives**: advisory lock per phone (session-bound, no ordering); a library (owner decision: hand-rolled).

## R3 — Lease and heartbeat
- **Decision**: lease 5 min; heartbeat every lease/3 extends it while the handler runs; `markDone/markRetry/markDead` include `WHERE locked_by = $lease` so a worker whose lease was taken over cannot finish the message.
- **Review amendment (Codex)**: the token is per claim (`<worker>/<uuid>`), not per worker — two slots of one process share the worker id, so a slot that reclaimed an expired message would otherwise let the earlier attempt renew or finish it. A heartbeat that matches nothing aborts the turn's `TurnLease.signal`, and writes are fenced: the turn checks `leaseHeld` before each model call, tool and state save, and every stamped write checks it inside its transaction with `FOR SHARE`, which also holds off a takeover (its claim uses `SKIP LOCKED`) until the write commits. Alternatives: a session advisory lock per turn (one pooled connection pinned per turn for the whole model loop); fencing only on heartbeat (a window of up to lease/3 with writes still allowed).

## R4 — Retries and dead letter
- **Decision**: backoff [2 s, 10 s, 30 s, 2 min, 10 min] × uniform(0.8, 1.2); after 5 attempts → `dead`, audit `inbound_dead_letter`, `escalateToHuman('inbound_failed')` in the same transaction. A dead row is finished, so the phone's next message becomes claimable.

## R5 — Flood guard and retention
- **Decision**: count unfinished rows of the phone inside the insert transaction, under `pg_advisory_xact_lock(hashtext('inbound:' || phone))` so concurrent deliveries are admitted one at a time (review: without it, READ COMMITTED lets them all see the same count); ≥ 20 → insert as `dropped` + `log.warn`. Done → `body = NULL`; `purgeInactive` deletes `done|dead|dropped` rows older than 90 days.

## R6 — Tracing
- **Decision**: store `currentTraceparent()` on insert; the worker runs the turn inside a root span linked to it (same helper as the outbox).

## R7 — Load and chaos tests
- **Decision**: integration load test in-process (4 workers, 200 messages, 10 phones, scripted LLM that records arrival order per phone); `scripts/inbound-chaos.ts` spawns `node --import tsx` child servers with fakes, sends messages, `kill -9` at random 3 times, restarts, waits for the queue to drain, and checks: every acknowledged id is `done`, none `processing`, no overbooking, no duplicate confirmed booking per phone.

## R8 — Replay guard (found by the chaos test)
- **Finding**: with seed 17 a worker died after a turn's booking committed but before the conversation state (with the processed message id) was saved; the reclaimed message ran again and the scripted model booked a second appointment.
- **Decision**: every final write (`booking_confirmed`, `booking_rescheduled`, `booking_cancelled`, `attendance_confirmed`, `escalated`) stamps `inboundMessageId` in its audit payload (`fencedStamp(client, deps)`) — the `inbound_message` id, unique across providers (second review: the provider's id is unique only per provider, so a global match could suppress another patient's message); at the start of a turn the orchestrator asks `committedTurnWrites(id)` and, if any, completes the calendar removal a committed cancel/reschedule does after its commit (second review: a crash in between left the event behind), marks the message processed, gives the conversation the status those writes imply (`applyCommittedTurn`: escalated → handed off, booked/rescheduled → completed with the booking, cancelled/attendance → completed — review: a replayed escalation used to leave the conversation `active`), flushes the outbox and stops; a replayed hand-off also sends the patient the hand-off reply the crash prevented. The patient still receives what the first run committed. A partial expression index on `payload->>'inboundMessageId'` keeps the check cheap; the query repeats the index predicate so the planner can use it.
- **Alternatives**: saving the conversation state in the tools' transactions (couples every tool to the conversation store); idempotency keys per tool call (the model's second run is a different call).
