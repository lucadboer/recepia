# Quickstart: Conversational Orchestration (behind fakes)

Validate the full conversational layer with **no LLM, no Calendar, no WhatsApp, no secrets** — fakes only.

## Setup
```bash
corepack enable && pnpm install
pnpm db:up && pnpm migrate   # applies 005_patient_consent … 008_outbox_message
pnpm test                    # unit + integration + concurrency
```

## What the behavioral suite proves (assert side-effects, never LLM text)
1. Book by chat: scripted FakeLLM (availability → hold → confirm) ⇒ 1 `FakeCalendar` event, 1 pt-BR `FakeMessaging` message, `hold_created`+`booking_confirmed` audit.
2. LLM-never-writes (structural): hostile FakeLLM (unknown tool / non-offered slot / foreign holdId) ⇒ 0 writes.
3. Escalate-on-doubt: "estou com dor" ⇒ `escalateToHuman`, `escalated` audit, pt-BR hand-off, **FakeLLM not called**.
4. Consent gate: no opt-in ⇒ no confirm; after opt-in ⇒ confirm; opt-out audited.
5. Bounded loop: runaway FakeLLM ⇒ stops at `MAX_ITERATIONS`, escalates.
6. Idempotent inbound: duplicate `providerMessageId` ⇒ no second side-effect.
7. Inbound parsers: Evolution/Cloud fixtures ⇒ normalized `InboundMessage`.
8. Adapter scaffolds: env unset ⇒ `NotConfigured`.

Feature-001 concurrency/anti-overbooking test stays green.

## Going live (NEEDS-USER)
Provide Anthropic/Calendar/WhatsApp creds + model id (see `claude-api` skill), patient/opt-in copy, LGPD retention, webhook hosting. See [plan.md](plan.md) NEEDS-USER list.
