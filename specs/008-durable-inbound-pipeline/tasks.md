# Tasks: Durable Inbound Message Pipeline

**Input**: `/specs/008-durable-inbound-pipeline/` (spec, plan, research, data-model, contracts/inbound-queue.md, quickstart)
**Tests**: required (constitution I); tests precede implementation.

## Phase 1: Setup
- [x] T801 Migration `013_inbound_message.sql`; `AuditAction` += `inbound_dead_letter`; config (`INBOUND_CONCURRENCY`, `INBOUND_LEASE_MS`, `INBOUND_MAX_ATTEMPTS`, `INBOUND_PHONE_MAX_PENDING`, `INBOUND_BACKOFF_MS`, `INBOUND_POLL_MS`); `tests/helpers/db.ts` `resetDb` truncates the new table

## Phase 2: Foundational — the queue
- [x] T802 [P] Unit tests: `inboundBackoff(attempt, random)` within ±20 % of [2 s, 10 s, 30 s, 2 min, 10 min], capped at the last step
- [x] T803 [P] Integration tests `tests/integration/inbound-repo.test.ts`: insert/duplicate/flood guard/traceparent; claim FIFO per phone; one in flight per phone with concurrent claimers; due-time respected; expired lease reclaimed; dead row unblocks; holder-only finish; done clears body; dead-letter atomic (row + audit + escalation)
- [x] T804 Implement `src/db/repositories/inbound-repo.ts` + backoff helper — make T802/T803 pass

## Phase 3: User Story 1 — no acknowledged message is lost (P1)
- [x] T805 [US1] Webhook tests (`webhook-server.test.ts`, `webhook-cloud-server.test.ts`): 200 only after the row exists; 503 when the insert fails; redelivery → one row; statuses still log-only
- [x] T806 [US1] Store-then-ack in `src/webhook/server.ts`; remove `RecentIds` / `PerKeyQueue` (and their tests) — make T805 pass
- [x] T807 [US1] Worker `src/jobs/inbound-worker.ts` (claim loop, heartbeat, concurrency, wake + poll, drain) + tests with a fake handler
- [x] T808 [US1] Wire the worker in `src/server.ts`; shutdown drains it (`src/webhook/shutdown.ts`); update `scripts/perf-smoke.ts`

## Phase 4: User Story 2 — order and one at a time (P1)
- [x] T809 [US2] Load test `tests/integration/inbound-load.test.ts`: 4 workers × 200 messages × 10 phones through the real orchestrator with a scripted LLM recording arrival order; order per phone preserved, no overlap, no overbooking

## Phase 5: User Story 3 — dead letter to reception (P2)
- [x] T810 [US3] Worker test: a handler that always fails → after 5 attempts dead + one reception hand-off; the phone's next message is processed

## Phase 6: User Story 4 — flood guard (P3)
- [x] T811 [US4] Webhook test: 25 messages of one phone → 20 pending, 5 dropped, warning logged; other phones unaffected

## Phase 7: Chaos, tracing, retention, docs

> Found by the chaos run (seed 17): a reclaimed message whose turn had already committed a booking was
> run again and booked twice. Fixed with a replay guard — every final write stamps the inbound
> message id in its audit row (`turnStamp`), and the orchestrator finishes a message whose turn
> already committed instead of re-running it (`orchestrator-replay.test.ts`, migration 013 index).
- [x] T812 `scripts/inbound-chaos.ts` + `pnpm chaos:inbound`; `perf.yml` runs it on the `perf` label and nightly
- [x] T813 Tracing: the worker turn links to the webhook span (extend `tracing.test.ts`)
- [x] T814 Retention purges finished inbound rows after 90 days (extend `retention.test.ts`)
- [x] T815 [P] ADR 0010 (durable queue: lease + FIFO), update ADR 0005, `docs/observability.md`, README (guarantees, architecture, roadmap), CLAUDE.md
- [x] T816 Gates: lint, typecheck, `test:coverage`, `evals:fake`, `evals:readme --check`, perf smoke, chaos run
- [x] T817 Codex review (xhigh) + self-review; fix all findings; tick this file

> Codex review (xhigh) findings, all fixed with tests: a replayed escalation now restores the
> hand-off (`applyCommittedTurn`); every claim has its own lease token; a turn that lost its
> message is signalled by the heartbeat and every final write is fenced on the lease inside its
> transaction (`leaseHeld … FOR SHARE`, `orchestrator-lease.test.ts`); flood admission is
> serialized per phone; the replay lookup repeats its partial index predicate.
>
> Second Codex pass, all fixed with tests: the conversation save and the consent writes are fenced
> inside their own transactions (`ConversationStorePort.save(state, { fence })`); a replayed
> cancel/reschedule finishes removing the calendar event; the dead letter persists the handed-off
> conversation state; final writes are stamped with the `inbound_message` id, not the provider's.
