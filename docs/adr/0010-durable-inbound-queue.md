# ADR 0010 — Durable inbound queue: store-then-ack, FIFO per phone with a lease, replay guard

- Status: accepted (feature 008, 2026-10-08)

## Context
The webhook used to acknowledge a patient message and then process it from an in-memory per-phone
queue. A crash or a restart between the acknowledgment and the end of the turn lost the message:
the provider does not resend what it already saw acknowledged. Per-phone ordering held only inside
one process.

## Decision
- **Store, then acknowledge.** The webhook inserts every verified message into `inbound_message`
  (`UNIQUE (provider, provider_message_id)`) and answers 200 only after the commit; 503 when it
  cannot, so the provider retries. A redelivery is a no-op.
- **One claim statement** (`UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`): a row
  is claimable when pending and due, or processing with an expired lease, it is the oldest
  unfinished row of its phone, and no other row of that phone holds a live lease. FIFO per phone
  and one turn in flight per phone across any number of workers, without session state.
- **Lease + heartbeat, one token per claim.** Each claim writes a fresh `locked_by` token
  (`<worker>/<uuid>`); heartbeat, done, retry and dead all match that token, so an earlier attempt
  — even one from another slot of the same worker — can neither renew nor finish a later claim.
  A worker that died is replaced after the lease.
- **Fencing** (review): a worker whose lease expired may still be running its turn when the message
  is reclaimed. A heartbeat that finds the message taken over aborts the turn's signal; the turn
  re-checks the lease before each model call and each tool; and every write of the turn — final
  writes, consent changes and the conversation save — checks it inside its own transaction with
  `SELECT … FOR SHARE` on the message row. A takeover's
  claim skips locked rows, so it cannot start until such a write has committed — and then the
  replay guard sees the write. A stale turn never undoes anything either: the hold it was
  confirming and that hold's calendar event (idempotent by hold id) may be the new holder's to
  confirm, so it only flags the hold (`booking.event_cleanup_pending`) and the hold sweep removes
  the event if the hold ends unconfirmed.
- **Flood guard under a per-phone lock**: the count of a phone's unfinished rows and the insert run
  under `pg_advisory_xact_lock`, so concurrent deliveries cannot pass the limit together.
- **Bounded turns**: every Google Calendar request times out (15 s). A turn still running after
  4 min is aborted; effects it already started (a compensating calendar delete) get a bounded grace
  period to settle, then the attempt fails (its lease token becomes void, so anything it still
  tries to write is fenced) and the slot is freed; a claim whose earlier
  attempts never finished (crashes) counts them, so the attempt limit holds across crashes too —
  such a claim only recovers what the last attempt committed (`recoverOnly`) and otherwise goes to
  reception. A replay whose calendar cleanup neither succeeds nor gets recorded fails, so the
  message is retried instead of finishing with the event left behind. Every connection sets
  Postgres `lock_timeout` (10 s): a timed-out turn stuck on a lock inside a fenced transaction
  fails and rolls back, releasing the message row so its attempt can be finished and reclaimed.
  Every direct patient reply is fenced on the lease as well.
- **Retries** with jittered backoff (2 s … 10 min); the 5th failed turn is followed by one recovery
  pass (no new turn: it only finishes what that attempt committed), and only a failed recovery
  marks the row dead, audits it and hands the patient to reception — notice and handed-off
  conversation state — in one transaction. The abandoned-event cleanup runs as its own job, apart
  from the hold sweep.
- **Replay guard** (found by the chaos test): every final write's audit row carries the
  `inbound_message` id (unique across providers, unlike the provider's message id); a reclaimed
  message whose turn already committed a final write is finished without running the model again:
  the calendar removal a cancel or reschedule does after its commit is completed, and the
  conversation gets the status those writes imply (a hand-off stays with reception, a booking
  finishes it), as the original turn would have saved it.
- Hand-rolled on Postgres (owner decision), the same pattern as the outbox (ADR 0004).

## Consequences
- An acknowledged message survives crashes and restarts; `scripts/inbound-chaos.ts` proves it with
  three `kill -9` per run (CI: `perf` label and nightly).
- The in-memory `RecentIds` and `PerKeyQueue` are gone (ADR 0005's in-process serialization is
  superseded; the conversation compare-and-swap remains the backstop).
- A turn killed after a hold but before its final write may leave one extra hold, which expires
  with its TTL.
- Patient replies sent directly inside a turn are still not durable (out of scope).
