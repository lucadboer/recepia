# Implementation Plan: Durable Inbound Message Pipeline

**Branch**: `008-durable-inbound-pipeline` | **Date**: 2026-10-08 | **Spec**: [spec.md](spec.md)

## Summary
The webhook stores each verified message in a new `inbound_message` table (`INSERT … ON CONFLICT DO NOTHING`, unique per provider + provider message id) and answers 200 only after the commit (503 when the insert fails). An in-process **inbound worker** (`INBOUND_CONCURRENCY`, default 4) claims one message at a time with `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`: a row is claimable when it is pending and due, or processing with an expired lease, and no older unfinished row of the same phone exists — FIFO per phone and one in flight per phone in a single condition. The claim sets a lease (`locked_until`, `locked_by`); a heartbeat extends it while the turn runs; only the holder can finish. Done → `body = NULL`. Failure → backoff 2 s, 10 s, 30 s, 2 min, 10 min ±20 %; the 5th failure → `dead` + `inbound_dead_letter` audit + `escalateToHuman('inbound_failed')` in one transaction. More than 20 unfinished rows of a phone → new rows stored as `dropped` + warning. The worker's turn span links to the webhook span through a stored `traceparent`. `RecentIds` and `PerKeyQueue` are removed; shutdown drains the worker. `scripts/inbound-chaos.ts` kills a child server three times mid-run and checks the invariants; `perf.yml` runs it on the `perf` label and nightly.

## Technical Context
- **Language/Version**: TypeScript on Node 24, ESM.
- **Primary Dependencies**: none new.
- **Storage**: migration `013_inbound_message.sql` (table + `UNIQUE (provider, provider_message_id)` + partial indexes `(phone, id) WHERE status IN ('pending','processing')` and `(next_attempt_at) WHERE status = 'pending'`); audit action `inbound_dead_letter`; retention purges finished rows after 90 days.
- **Testing**: unit (backoff/jitter, lease math), integration against Postgres (insert/dedupe, claim FIFO + one-in-flight with concurrent claimers, lease takeover, heartbeat, holder-only finish, dead-letter atomicity, flood guard, 503 on insert failure, retention), webhook integration (ack after commit, redelivery), load test (4 workers × 200 messages × 10 phones, order checked against what the scripted LLM saw), chaos script (kill -9 × 3).
- **Constraints**: the queue never bypasses the orchestrator's idempotency; no new dependency; zero live model spend.
- **Scale/Scope**: one clinic; tens of messages per minute.

## Constitution Check
| Principle | Status | Compliance |
|---|---|---|
| I Test-First | ✅ | Every queue behaviour is written test-first; the no-overbooking gate and the new load/chaos invariants prove effects stay exactly-once. |
| II LLM Never Writes | ✅ | The pipeline only moves messages to the unchanged orchestrator. |
| III Simplicity/YAGNI | ✅ | Hand-rolled with the outbox's proven pattern; removes two in-memory structures (net simplification). |
| IV Escalate on Doubt | ✅ | A message that keeps failing becomes a reception hand-off, never a silent drop. |
| V Traceability/LGPD | ✅ | Dead letters audited; message text cleared after processing; 90-day purge. |

Gate: **pass**.

## Project Structure
```text
src/db/migrations/013_inbound_message.sql
src/db/repositories/inbound-repo.ts      # insertInbound, claimNext, heartbeat, markDone, markRetry, markDead, pendingCount
src/jobs/inbound-worker.ts               # createInboundWorker({ deps, handler, concurrency }) → { wake, drain, stop }
src/webhook/server.ts                    # store-then-ack; RecentIds/PerKeyQueue removed
src/webhook/dispatch.ts, cloud-dispatch.ts # parse/verify only
src/webhook/shutdown.ts                  # drains the worker
src/server.ts                            # wires the worker
src/jobs/retention.ts                    # + inbound_message purge
scripts/perf-smoke.ts, scripts/inbound-chaos.ts, .github/workflows/perf.yml
docs/adr/0010-durable-inbound-queue.md, docs/adr/0005 (update), docs/observability.md, README
```

## Complexity Tracking
| Item | Why needed | Simpler alternative rejected because |
|---|---|---|
| Lease + heartbeat | crash recovery without losing or double-running a turn (FR-804) | a plain `processing` status would strand messages of a dead worker forever |
| One-condition FIFO claim (`NOT EXISTS` older unfinished of the phone) | per-phone order across workers (FR-803) | advisory locks per phone need a session per worker and do not order |
