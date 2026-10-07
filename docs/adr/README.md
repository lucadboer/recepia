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
