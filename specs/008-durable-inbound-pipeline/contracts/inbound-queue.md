# Contract: Durable Inbound Queue

## `insertInbound(client, msg, provider, now) -> 'inserted' | 'duplicate' | 'dropped'`
**Guarantees**: unique per (provider, provider id); ≥ 20 unfinished rows of the phone → stored as `dropped`; stores the active traceparent.
**Required Tests**: duplicate ignored; flood guard; traceparent stored.

## `claimNext(pool, workerId, now, leaseMs) -> InboundRow | null`
**Guarantees**: FIFO per phone; at most one live `processing` row per phone; due pending or lease-expired processing rows only; `attempts + 1`.
**Required Tests**: order per phone; two concurrent claimers never take two rows of one phone; expired lease reclaimed; not-yet-due skipped; a dead row unblocks the phone.

## `heartbeat / markDone / markRetry / markDead`
**Guarantees**: only the lease holder (`locked_by`) can change the row; done clears `body`; dead = audit + reception hand-off in one transaction.
**Required Tests**: a taken-over worker cannot finish; dead-letter atomicity; retry delay within jitter bounds.

## Webhook
**Guarantees**: 200 only after the insert committed; 503 when it fails; redelivery → 200 without a second row.
**Required Tests**: ack after commit; 503 path; redelivery after 200 processed once.

## Worker
**Guarantees**: concurrency limit; heartbeat while running; drain on shutdown; wake on insert with a 1 s poll fallback.
**Required Tests**: load test order + no overlap per phone; chaos invariants.
