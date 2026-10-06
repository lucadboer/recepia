# Data Model: Evaluation Harness

No new database tables. Everything below is a file format or an in-memory structure of the harness, plus two small additions to existing application types.

## Files in the repository
| Path | Content | Written by |
|---|---|---|
| `evals/cases/<id>.json` | one Eval Case | humans (reviewed) |
| `evals/pricing.json` | Pricing Table (dated) | humans |
| `evals/baseline.json` | Baseline (live metrics + model + prompt version + date) | humans, via reviewed PR |
| `evals/reports/latest.json`, `latest.md` | latest Report | the runner; published by the automation's PR |
| `evals/judge/rubric.vN.md` | Judge Rubric | humans |
| `prompts/system/vNNN.md`, `prompts/CHANGELOG.md` | Prompt Version | humans |

## Eval Case (`evals/cases/*.json`)
| Field | Type | Notes |
|---|---|---|
| `id` | string, unique, = file name | e.g. `happy-01-cleaning-tomorrow` |
| `category` | `happy_path` \| `alternative_slot` \| `reschedule_cancel` \| `ambiguous_date` \| `out_of_scope` \| `opt_out` \| `consent_refusal` \| `injection` | drives per-category metrics; `injection` is the adversarial set |
| `title` | string | one line, pt-BR allowed |
| `limitation` | string? | present when the expectation encodes a current limitation (e.g. reschedule → hand-off) |
| `seed.now` | ISO instant | the FakeClock for the whole case |
| `seed.capacity` | `{ weekday, start, end, capacity }[]` | capacity rules; overrides optional (`seed.overrides`) |
| `seed.bookings` | `{ start, phone, status, seat }[]`? | pre-existing bookings/holds to make slots full etc. |
| `seed.consent` | `none` \| `opted_in` \| `opted_out` | consent ledger state before the first turn |
| `patient.phone` | string (fictitious E.164) | the conversation key |
| `turns` | `{ text, id? }[]` | patient messages in order (`id` defaults to `<caseId>-<n>`) |
| `llmScript` | `ScriptTurn[][]` | per inbound turn, the stand-in's moves (see contract); ignored in live mode |
| `labels.shouldEscalate` | boolean | ground truth for precision/recall |
| `labels.escalationReason` | string? | expected reason category |
| `expect` | Expectation | deterministic-mode expectations |
| `liveExpect` | Partial<Expectation>? | overrides for live mode (looser tool-call matching) |

## Expectation
| Field | Type | Notes |
|---|---|---|
| `toolCalls.mustInclude` | `{ name, input? }[]` | ordered subsequence; `input` values are matchers |
| `toolCalls.mustNotInclude` | `string[]` | tool names that must never be called |
| `writes` | `{ holds, bookings, calendarEvents, escalations }` | exact counts at the end of the case |
| `escalation` | `{ expected: boolean, reasonIn?: string[] }` | exactly once when expected |
| `noWriteWithoutConsent` | boolean (default true) | every booking write happened with `opted_in` recorded |
| `noHallucinatedSlots` | boolean (default true) | every hold start ∈ slots returned by `get_availability` in this conversation |
| `status` | `active` \| `escalated` \| `completed` | final conversation status |
| `patientMessages` | number? | exact count of messages to the patient |

Matchers for `input` fields: literal JSON value · `{ "$in": [...] }` · `"$offeredSlot"` · `"$ownHoldId"` · `"$any"`.

## Run / Execution / Case Result (in memory → report)
- **Run**: `{ mode, model, promptVersion, commit, startedAt, repetitions, capUsd, judge: boolean, cases: CaseResult[] , metrics, baselineComparison?, judge?: JudgeResult[] }`.
- **Execution** (one pass of a case): `{ caseId, rep, observations, assertions: { name, pass, detail }[], pass, latency: { perTurnMs[], totalMs }, usage: { input, output, cacheRead, cacheWrite }, costUsd, errors: { kind, message }[] }`.
- **Observations**: `{ toolCalls: { name, input, ok }[], writes, escalations: { reason }[], offeredSlots, heldStarts, consentBeforeWrite: boolean, status, messages: { to, body }[] }`.
- **Metrics**: `{ taskSuccess: { overall, byCategory }, toolCallAccuracy, escalation: { triage: { precision, recall }, agent: { precision, recall } }, injectionResistance, latency: { turnP50, turnP95, conversationP50, conversationP95 }, cost: { perConversationUsd, totalUsd, tokens }, errors }`.

## Report (`evals/reports/latest.json` + `latest.md`)
Run metadata + metrics + per-case summaries + (optional) judge + `honesty: "authored golden set; no production data"`. The Markdown mirrors the JSON; the README block is rendered from the JSON only.

## Baseline (`evals/baseline.json`)
`{ model, promptVersion, date, commit, metrics }` — the live run compares `taskSuccess.byCategory` and `injectionResistance` against it; tolerance 5 pp (FR-407).

## Prompt Version
`prompts/system/v001.md` (static block) + `CHANGELOG.md`. Identifier `vNNN+<sha256(content)[:7]>`. Recorded in: `LlmTurnInput.promptVersion`, `ConversationState.promptVersion` (last used), audit payloads of `hold_created`, `booking_confirmed`, `escalated` (actor `ai`), and every report.

## Application type changes (existing code)
- `LlmTurnResult.usage?: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`; `stopReason` gains `"refusal"`.
- `LlmContent` gains an opaque `{ type: "thinking"; raw: unknown }` carried within a turn and stripped on persist.
- `LlmTurnInput.promptVersion?: string`.
- `Deps.promptVersion?: string` (set per turn by the orchestrator); audit payloads include it when present.
- `ConversationState.promptVersion: string | null`.
