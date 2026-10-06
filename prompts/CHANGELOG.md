# System prompt changelog

The agent's system prompt is a versioned artifact: `prompts/system/vNNN.md` is the static block
(placeholders `{{routine_types}}` and `{{tool_names}}` are rendered from code); the loader appends
one dated line per turn (today's weekday/date/time/timezone). The version id recorded on every
model call, in audit payloads of model-initiated writes and in every eval report is
`vNNN+<sha256(file)[:7]>`, so any edit — even one character — is traceable.

Rules: a new file (`v002.md`, …) for a change in instructions; an entry here for every version
(the loader refuses to start without it); a baseline update in the same PR when the eval numbers
move (feature 004).

## v001 — 2026-10-06
- Initial artifact: the static block moved verbatim from `src/agent/system-prompt.ts` (pilot copy
  accepted by the owner, T220/T221). Defense-in-depth wording only; the structural guarantees are
  the gates in `tool-registry.ts` and the orchestrator.
