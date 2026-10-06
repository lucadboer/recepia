# ADR 0003 — Deterministic tools are the only writers; the LLM proposes

- Status: accepted (features 001–002, 2026-06)

## Context
An LLM must never invent a time slot, confirm without consent or write anywhere directly
(constitution principles II and IV). Prompt instructions alone are not a guarantee.

## Decision
Build and test the deterministic layer first (`get_availability`, `hold_slot`, `confirm_booking`,
`escalate_to_human`), behind ports with in-memory fakes. The LLM only sees a closed tool allowlist
and three structural gates in `src/agent/tool-registry.ts`:
1. unknown tools are rejected;
2. `hold_slot` only accepts a start that `get_availability` returned **in this conversation**;
3. `confirm_booking` only accepts a hold created **in this conversation**, after the opt-in consent
   gate.
A deterministic regex triage runs before the model and escalates urgency, specialized procedures,
prices, complaints and explicit requests for a human. The conversation layer is tested by the tool
calls it makes (behavioural tests with a scripted, hostile `FakeLLM`), never by the model's text.

## Consequences
- "The LLM never writes" is enforced structurally; a hostile model can only call the four tools
  with inputs the gates accept.
- Guardrails that belong to the deterministic layer stay there (e.g. `hold_slot` re-validates the
  booking window and grid), so they also hold for future callers such as an MCP server.
- Behaviour that needs judgement (tone, clarity) is evaluated separately (feature 004), not tested.
