# ADR 0004 — Transactional outbox for patient and reception messages

- Status: accepted (feature 002 Phase 11, 2026-10)

## Context
`confirm_booking` used to flip the booking and then call WhatsApp directly. A send failure after
the commit left a confirmed booking the patient never heard about, and a commit failure after the
send told the patient about a booking that did not exist (findings T231/T232).

## Decision
The message is written to `outbox_message` **in the same transaction** as the domain write
(`booking_confirmed`, `escalated`). A dispatcher claims one due row per transaction with
`FOR UPDATE SKIP LOCKED`, sends through `MessagingPort` with a timeout, and marks it `sent` or
schedules a retry (5 s → 30 s → 2 m → 10 m → 30 m). The sixth failure dead-letters the row
(`failed`), audits it and notifies reception. The orchestrator flushes only its own conversation's
rows right after persisting state; a 15 s poller handles retries and anything a crashed turn left.
Opt-out cancels the patient's pending rows in the consent transaction.

## Consequences
- Delivery is at-least-once: a crash between send and commit, or a send that times out after the
  provider delivered, can duplicate a message. Accepted for now; idempotent sends keyed by provider
  message id are planned with the durable inbound pipeline (feature 008; renumbered on 2026-10-08 when reschedule/cancel became 006).
- A `confirmed` outcome means "the outbox owns the patient reply", so the orchestrator never adds
  a second message — including when a COMMIT landed but its acknowledgment was lost.
