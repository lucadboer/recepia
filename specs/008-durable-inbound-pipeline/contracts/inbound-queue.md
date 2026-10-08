# Contract: Durable Inbound Queue

## `insertInbound(client, msg, provider, now) -> 'inserted' | 'duplicate' | 'dropped'`
**Guarantees**: unique per (provider, provider id); ≥ 20 unfinished rows of the phone → stored as `dropped`, admission serialized per phone (transaction advisory lock); stores the active traceparent.
**Required Tests**: duplicate ignored; flood guard; concurrent deliveries never pass the limit; traceparent stored.

## `claimNext(pool, workerId, now, leaseMs) -> InboundRow | null`
**Guarantees**: FIFO per phone; at most one live `processing` row per phone; due pending or lease-expired processing rows only; `attempts + 1`; a fresh lease token per claim (`row.lease`).
**Required Tests**: order per phone; two concurrent claimers never take two rows of one phone; expired lease reclaimed; not-yet-due skipped; a dead row unblocks the phone.

## `heartbeat / markDone / markRetry / markDead (…, lease, …)`
**Guarantees**: only the claim whose token is in `locked_by` can change the row; done clears `body`; dead = audit + reception notice + handed-off conversation state in one transaction.
**Required Tests**: a taken-over worker cannot finish; a reclaim by the same worker invalidates the earlier attempt; dead-letter atomicity; dead letter leaves the conversation handed off; retry delay within jitter bounds.

## `leaseHeld(q, id, lease) -> boolean` (the fence)
**Guarantees**: true only while that claim holds the message; inside a transaction it locks the row (`FOR SHARE`) until the transaction ends, so a takeover waits for the write.
**Required Tests**: false after a takeover or a finish; a takeover cannot claim while a fenced write is open.

## Webhook
**Guarantees**: 200 only after the insert committed; 503 when it fails; redelivery → 200 without a second row.
**Required Tests**: ack after commit; 503 path; redelivery after 200 processed once.

## Worker
**Guarantees**: concurrency limit; heartbeat while running; drain on shutdown; wake on insert with a 1 s poll fallback; each turn gets its claim's `TurnLease` (`signal` aborted when a heartbeat finds the message taken over, `fence(q)` for writes); a turn that lost its message finishes nothing.
**Required Tests**: load test order + no overlap per phone; chaos invariants; a taken-over turn is signalled and records nothing.

## Orchestrator (with `deps.lease`)
**Guarantees**: the lease is checked before each model call and each tool; after a lease loss a confirm/reschedule attempt neither releases the hold nor deletes its event (the new holder may confirm that hold) — it flags the hold and the hold sweep (`removeAbandonedEvents`) removes the event only if the hold ends unconfirmed; every final write, consent change and conversation save is fenced in its own transaction; a stale turn writes nothing and notifies no one. Final writes are stamped with the `inbound_message` id (`InboundMessage.inboundMessageId`). A replayed message whose turn committed completes the post-commit calendar removal of a cancel/reschedule and gets that turn's conversation status (hand-off stays handed off).
**Required Tests**: lease lost during a model call → the next tool never runs; lost between the check and the commit → the write rolls back and the calendar event is compensated; lost after the tools committed → the save refuses and the new holder's replay finishes; a stale escalation or opt-out is not written; no direct reply is sent once the message was taken over; a replayed escalation keeps reception in charge; a replayed cancel removes the event; the same provider id from two providers is two messages; a stale confirm/reschedule leaves the hold usable by the new holder; a flagged hold's event is removed once the hold expired, never after it was confirmed.

## Worker bounds
**Guarantees**: Calendar requests time out (`CALENDAR_REQUEST_TIMEOUT_MS`, 15 s); a turn running past `INBOUND_TURN_TIMEOUT_MS` (4 min) is aborted, gets `INBOUND_TURN_GRACE_MS` for effects already under way to settle, then fails its attempt (retry or dead letter) with its token voided, and the slot is freed; the last failed turn attempt is followed by one recovery pass before any dead letter; a claim whose attempt count is already past the limit (earlier attempts crashed) runs in recover-only mode — what the last attempt committed is recovered, nothing is run again, and with nothing to recover (AttemptsExhaustedError) the message is dead-lettered.
**Required Tests**: a never-settling turn frees the only slot and its message is retried; a message whose turns kept crashing is only recovered (done) or, with nothing to recover, goes to reception; recover-only never calls the model; a replay whose cleanup cannot settle fails (CleanupPendingError) and the retry settles it; a timed-out turn's in-flight effects settle before the message is retryable; the last attempt's committed work is recovered, not dead-lettered; the abandoned-event cleanup is its own job; a timed-out turn stuck on a lock inside its fenced save does not strand its message (connection `lock_timeout`).

## Worker shutdown
**Guarantees**: `drain()` returns as soon as the turns in flight finish, even when it starts while a claim is in flight (no idle wait after stopping).
**Required Tests**: drain during a slow claim returns well before the poll interval.
