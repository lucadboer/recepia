# ADR 0005 — Optimistic concurrency for conversation state

- Status: accepted (feature 002 Phase 11, 2026-10)

## Context
Conversation state (history, offered slots, holds, dedupe ids) is a JSONB row per phone, loaded at
the start of a turn and saved at the end. Two quick messages from the same patient processed
concurrently made the last save win and silently dropped the other turn's state (lost update).

## Decision
`conversation_state.version` with a compare-and-swap save: `UPDATE … WHERE version = $expected`;
zero rows → `ConversationConflictError`. The webhook additionally serializes `onInbound` per phone
in-process (`PerKeyQueue`), so conflicts only occur across processes or against the operator's
release command. A conflicting turn fails loudly, delivers nothing and is not retried: tool writes
already committed are idempotent, and re-running the LLM could duplicate side-effects.

## Consequences
- No lost updates; the in-memory fake store mirrors the CAS so fake-based tests catch regressions.
- Redelivery of the lost message is the provider's job (edge dedupe records an id only after a
  successful turn); feature 006 replaces the in-process queue with a durable Postgres queue.
