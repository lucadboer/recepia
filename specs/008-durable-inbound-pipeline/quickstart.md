# Quickstart: Durable Inbound Message Pipeline

```bash
pnpm migrate                         # 013_inbound_message.sql
pnpm test:integration                # queue, worker, webhook store-then-ack, load test
pnpm chaos:inbound                   # scripts/inbound-chaos.ts — kill -9 × 3 and restart
pnpm perf:smoke
```
Expected: the chaos run prints every acknowledged id processed, none stuck in `processing`, no overbooking, no duplicate booking; the perf smoke stays within its p95 budget.

Configuration: `INBOUND_CONCURRENCY` (4), `INBOUND_LEASE_MS` (300000), `INBOUND_MAX_ATTEMPTS` (5), `INBOUND_PHONE_MAX_PENDING` (20).
