# ADR 0012 — Model-facing text in English, patient-facing text in Brazilian Portuguese

- Status: accepted (prompt v004, 2026-11-09; owner decision: all code and documentation in English)

## Context
The repository moved to English for code and documentation, but the text the model reads was
still Portuguese: the system prompt (`prompts/system/v003.md`), the dated line and the reminder
context line, the tool descriptions, the registry's gate messages and the feedback after a failed
tool. That text is code in every sense that matters: it is versioned, reviewed, traced by id and
tested. Leaving it in Portuguese meant a reviewer could not read the agent's instructions, and the
two languages mixed inside one request (Portuguese descriptions on English tool names).

The product constraint does not move: every string a patient reads is Brazilian Portuguese
(constitution, FR-019), and so is everything the reception reads.

## Decision
- **English**: the instructions in `prompts/system/v004.md`, the dated line and the reminder
  context line (`src/agent/system-prompt.ts`), the tool descriptions (`src/agent/tool-schemas.ts`),
  the gate messages in `src/agent/tool-registry.ts`, the failed-tool feedback
  (`src/agent/tool-feedback.ts`) and the domain error messages the model may see.
- **Portuguese, unchanged**: every patient-facing template (`src/messages.ts`, `src/agent/reply.ts`),
  the reception hand-off context, and the sample phrasing inside the prompt. The samples are the
  register the replies should have, so they stay in the language of the replies.
- **An explicit language rule** in the first line of the prompt: always write to the patient in
  pt-BR, whatever the language of the instructions or of the patient's message.
- **The dated line gives the date in ISO form** (`2026-07-15`): an English sentence around
  `15/07/2026` invites a month/day reading; an ISO date has one.
- **A new eval invariant, on by default for every golden case**: `repliesInPortuguese` fails the
  case if any message to the patient reads as English (`looksPortuguese`: a marker-word heuristic
  that only flags a message with at least two English markers and more English than Portuguese
  ones, so a short reply such as "Ok!" never fails). It runs in the deterministic gate (over the
  scripted replies and every template) and in the live run (over the real model's replies).
- A new prompt version (`v004`), so the change is traceable in every call, audit payload and
  report, and measured against the v003 baseline with the full live run before it ships.

## Alternatives considered
- **Keep everything model-facing in Portuguese.** The safest default for reply language, but it
  keeps the agent's instructions unreadable to most reviewers and leaves two languages in one
  request. Rejected once the eval could prove the reply language instead of assuming it.
- **Translate the patient-facing templates too and let the model translate back.** Rejected: the
  templates are what the patient sees verbatim (confirmation, cancellation, reminder); a model
  in the path of a fixed message adds cost and a failure mode for no gain.
- **Ask for pt-BR only in the tool descriptions.** Too weak: the reply language is a property of
  the whole conversation, so it belongs in the first line of the system prompt.

## Consequences
- The main risk — the model drifting into English after reading English instructions — is now a
  measured property: every live run checks every reply, and a single English reply fails its case.
- Reviewers read one language in the code and the prompt; the pt-BR samples double as the style
  guide for the replies.
- The language heuristic is deliberately simple. It can miss a reply that mixes languages without
  enough English markers; the optional tone/clarity judge (a different model, never a gate) is the
  second look.
- The full live run for v004 is the gate for this decision: its report replaces v003's
  (`evals/reports/latest.md`), and the baseline moves in the same pull request, per the prompt
  policy in `prompts/CHANGELOG.md`.

## Validation (full live run, 2026-11-09, one repetition, `claude-sonnet-5-5`)
- Every golden case passed, including the two v003 missed (a consultation "next week" that was
  never booked; an attendance confirmation that was never recorded). Every reply was pt-BR.
- Agent escalation precision went down: two more conservative hand-offs, both in injection cases
  and both with zero writes (an attempt to confirm another conversation's hold now reaches
  `find_my_booking`, which finds nothing and hands off by code; a request to cancel someone
  else's appointment is handed off by the model). Escalating when in doubt is the failure
  direction the constitution accepts; recall stayed at 100 %.
- Cost per conversation rose by about 7 %: the new prompt prefix was written to the cache again
  (cache hit ratio down two points). One repetition is noisy for latency; the numbers live in the
  report, not here.
