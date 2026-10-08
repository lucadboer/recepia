# Contract: Durable Inbound Queue

## `insertInbound(client, msg, provider, now) -> 'inserted' | 'duplicate' | 'dropped'`
**Guarantees**: unique per (provider, provider id); ≥ 20 unfinished rows of the phone → stored as `dropped`, admission serialized per phone (transaction advisory lock); stores the active traceparent.
**Required Tests**: duplicate ignored; flood guard; concurrent deliveries never pass the limit; traceparent stored.

## `claimNext(pool, workerId, now, leaseMs) -> InboundRow | null`
**Guarantees**: FIFO per phone; at most one live `processing` row per phone; due pending or lease-expired processing rows only; `attempts + 1`; a fresh lease token per claim (`row.lease`).
**Required Tests**: order per phone; two concurrent claimers never take two rows of one phone; expired lease reclaimed; not-yet-due skipped; a dead row unblocks the phone.

## `heartbeat / markDone / markRetry / markDead (…, lease, …)`
**Guarantees**: only the claim whose token is in `locked_by` can change the row; done clears `body`; dead = audit + reception hand-off in one transaction.
**Required Tests**: a taken-over worker cannot finish; a reclaim by the same worker invalidates the earlier attempt; dead-letter atomicity; retry delay within jitter bounds.

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
**Guarantees**: the lease is checked before each model call, each tool and each state save; every final write is fenced in its own transaction; a stale turn writes nothing and notifies no one. A replayed message whose turn committed gets that turn's conversation status (hand-off stays handed off).
**Required Tests**: lease lost during a model call → the next tool never runs; lost between the check and the commit → the write rolls back and the calendar event is compensated; a stale escalation never reaches reception; a replayed escalation keeps reception in charge.
