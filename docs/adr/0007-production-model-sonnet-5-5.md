# ADR 0007 — Production model `claude-sonnet-5-5`, minimal thinking, reasoning never persisted

- Status: accepted (feature 004, 2026-10-06; owner decision in the 004 clarifications)

## Context
The agent ran on `claude-sonnet-4-6` with thinking off. The evaluation harness (feature 004)
must measure the model that is actually deployed, and the owner chose the newest Sonnet
(`claude-sonnet-5-5`, US$ 2 / 10 per MTok vs 3 / 15). That model changes the API contract:
`thinking: {type: "disabled"}` and forced `tool_choice` return 400, thinking/progress blocks
are signed against the exact request prefix that produced them ("preserved thinking"), and
the safety layer can end a response with `stop_reason: "refusal"`.

## Decision
- `DEFAULT_MODEL = "claude-sonnet-5-5"`; the request sends `thinking: {type: "between_tools"}`
  (the lowest setting on this model) with `output_config.effort: "low"`, `strict: true` tools
  (schemas carry `additionalProperties: false`) and never a forced `tool_choice`. The knobs are
  a pure per-model table (`requestTuningFor`) so an eval run on another model never re-sends a
  field that model rejects.
- Reasoning blocks are carried opaquely through the port (`{ type: "thinking", raw }`), passed
  back byte-for-byte within the inbound turn that produced them, and **stripped before the
  conversation state is persisted**. Our history is edited between inbound turns (dated prompt
  line, trimming), which would invalidate a replayed block; the orchestrator's history is
  append-only within a turn, which is what the check requires.
- `stop_reason: "refusal"` → the turn is discarded (no tool from it runs) and the conversation
  is handed to reception with reason `model_refusal`; `max_tokens` while calling a tool →
  `model_truncated`. The patient never receives an empty reply (constitution IV).
- Token usage is reported on the port (`LlmTurnResult.usage`, zeros from fakes) so the harness
  and, later, observability (feature 005) cost each conversation from one shape.

## Consequences
- Lowest latency/cost setting for a short, tool-driven dialogue; adaptive thinking at `low`
  effort stays an option to measure with the harness (`--model`) before changing the default.
- Replaying thinking across inbound turns would need the `block_binding: drop_block` beta with
  adaptive thinking; not needed while blocks are stripped on persist.
- The live validation (`LIVE_LLM=1 pnpm test:live`) is the gate for this decision; the adapter
  is unit-tested against a stubbed SDK client for the request shape and response mapping.
