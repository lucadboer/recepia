# Architecture Decision Records

Short records (MADR style) of the decisions that shape this codebase. Product decisions live in
the specs (`specs/*/spec.md`); these are the technical ones a reviewer would ask about.

| ADR | Decision |
|---|---|
| [0001](0001-advisory-locks-and-seat-model.md) | Per-slot advisory lock + seat model instead of `SERIALIZABLE` transactions for no-overbooking |
| [0002](0002-append-only-audit-log.md) | `audit_log` made append-only by database triggers, written in the same transaction as the domain write |
| [0003](0003-deterministic-tools-before-llm.md) | Deterministic tools are the only writers; the LLM proposes through a closed allowlist with structural gates |
| [0004](0004-transactional-outbox.md) | Patient/reception messages go through a transactional outbox with retries and dead-letter |
| [0005](0005-optimistic-concurrency-conversation-state.md) | Conversation state uses compare-and-swap (`version`) plus per-phone in-process serialization |
| [0006](0006-pooled-capacity.md) | Capacity is a pooled counter per slot; patients do not choose a dentist in the MVP |
| [0007](0007-production-model-sonnet-5-5.md) | Production model `claude-sonnet-5-5` with the lowest thinking setting; reasoning blocks never persisted; refusals and truncated tool calls hand off to reception |
| [0008](0008-telemetry-api-only-and-pii.md) | OpenTelemetry API in business code, SDK only at the process edge; keyed patient pseudonym, no content and no phones in logs or traces |
| [0009](0009-reschedule-as-new-row.md) | A reschedule is a new booking row swapped in atomically (`rescheduled_from`, unique); cancel is database-first; the calendar is compensated, never trusted over Postgres |
| [0010](0010-durable-inbound-queue.md) | Store-then-ack inbound queue: FIFO per phone with a lease, jittered retries, dead letter to reception, replay guard for reclaimed messages |
| [0011](0011-container-image.md) | Container image: `tsc` build with import-extension rewriting, distroless non-root runtime pinned by digest, `@googleapis/calendar`, Trivy + smoke test in CI, GHCR push with SBOM and provenance |
