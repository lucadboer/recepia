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
- **Lease + heartbeat**, holder-only finish (`WHERE locked_by = $worker`): a worker that died is
  replaced after the lease; a worker whose lease was taken over cannot finish the message.
- **Retries** with jittered backoff (2 s … 10 min); the 5th failure marks the row dead, audits it
  and hands the patient to reception in one transaction.
- **Replay guard** (found by the chaos test): every final write's audit row carries the inbound
  message id; a reclaimed message whose turn already committed a final write is finished without
  running the model again.
- Hand-rolled on Postgres (owner decision), the same pattern as the outbox (ADR 0004).

## Consequences
- An acknowledged message survives crashes and restarts; `scripts/inbound-chaos.ts` proves it with
  three `kill -9` per run (CI: `perf` label and nightly).
- The in-memory `RecentIds` and `PerKeyQueue` are gone (ADR 0005's in-process serialization is
  superseded; the conversation compare-and-swap remains the backstop).
- A turn killed after a hold but before its final write may leave one extra hold, which expires
  with its TTL.
- Patient replies sent directly inside a turn are still not durable (out of scope).
