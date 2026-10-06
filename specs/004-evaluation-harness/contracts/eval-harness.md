# Contract: Evaluation Harness

Format: API + Guarantees + Required Tests (tests written BEFORE implementation, per constitution I).

## Case file (`evals/cases/<id>.json`)
- **API**: shape in [data-model.md](../data-model.md). `llmScript[i]` is the stand-in's behaviour for inbound turn `i`: an array of moves, each `{ "text": "..." }` (final reply) or `{ "tool": "<name>", "input": {...} }`; several tool moves in a row mean one tool call per iteration; a move with `"tools": [...]` emits several `tool_use` blocks in one response. Placeholders inside `input` strings: `$offeredSlot[n]` (n-th start of the last availability result), `$lastHoldId`, `$otherConversationHoldId` (a real hold seeded for another phone), `$foreignPhone`.
- **Guarantees**: the loader rejects unknown fields, duplicate ids, categories outside the enum, a script shorter than `turns`, and placeholders it cannot resolve; `injection` cases must have `labels.shouldEscalate` or `writes` all zero.
- **Tests**: valid case loads; each invalid shape is rejected with the field named; placeholder resolution against a fake observation.

## `runCase(case, { mode, llm, pool, clock }) -> Execution`
- **Guarantees**: truncates mutable tables and applies the seed before the case; builds `AgentDeps` with `FakeCalendar`, `FakeMessaging`, `DbConversationStore`, `FakeClock(seed.now)`; drives `handleInbound` once per patient turn; records every tool call (by wrapping the registry's observable effects: outbox/audit/booking rows, `FakeCalendar.events`, `FakeMessaging.sent`, conversation state) and per-turn latency/usage; never throws for an agent-level failure (it is an observation); a thrown infrastructure error is recorded as an `error` and fails the execution.
- **Tests**: the happy-path case yields `bookings = 1`, `calendarEvents = 1`, `status = completed`; the never-offered-slot injection case yields `holds = 0`; a case with a tool error in the script still completes with observations.

## `score(execution, expectation) -> Assertion[]`
- **Guarantees**: pure; one assertion per expectation field; subsequence matching for `mustInclude` with matchers; `noHallucinatedSlots` compares held starts with offered starts; `noWriteWithoutConsent` uses the consent state observed before each write.
- **Tests**: each matcher kind; subsequence vs non-subsequence; hallucinated slot detected; write without consent detected; status mismatch.

## `computeMetrics(executions, cases) -> Metrics`
- **Guarantees**: pure; definitions in [research.md R5](../research.md); precision/recall handle zero denominators (reported as `null`, never NaN); latency percentiles nearest-rank; cost from the pricing table for the run's model (missing model → `null` cost + warning).
- **Tests**: hand-computed fixtures for every metric; zero-denominator cases; cost arithmetic.

## `pnpm evals:fake | evals:live | evals:readme [--check] | evals:judge` (CLI `evals/run.ts`)
- **Guarantees**: `fake` needs only `DATABASE_URL`, is deterministic (same results on repeated runs) and exits non-zero on any failing execution; `live` requires `ANTHROPIC_API_KEY` (else exits 0 with an explicit "skipped" notice and no report), runs `--repetitions` (default 3), stops when the accumulated estimated cost would exceed `--cap-usd` (default 5) and marks the report partial, compares with `evals/baseline.json` when present and exits non-zero on regression; both modes write `evals/reports/latest.json` + `latest.md` with mode, model, prompt version, commit and date; `readme` regenerates the README block, `readme --check` exits non-zero on drift; `judge` is off unless requested.
- **Tests**: integration: fake run over the real golden set passes and is repeatable (two runs → identical per-case results); `readme --check` fails after a hand edit; live mode skip path without a key (unit, by injecting env).

## Prompt artifact (`prompts/system/vNNN.md`)
- **Guarantees**: `buildSystemPrompt(ctx)` returns `{ text, version }` where `text` = file content + dated line and `version` = `vNNN+<sha256[:7]>`; the loader fails fast if no `vNNN.md` exists or the CHANGELOG lacks the newest version; the static part is byte-identical across calls (cache-friendly).
- **Tests**: version changes when the file content changes; CHANGELOG mismatch fails; orchestrator passes the version to tools (audit payload) and to the LLM input.

## `LLMPort` additions
- **Guarantees**: `turn()` returns `usage` when the provider reports it (FakeLLM returns zeros); `stopReason` may be `"refusal"`, which the orchestrator turns into an escalation with reason `model_refusal` and a pt-BR hand-off reply; thinking blocks are carried within the turn and stripped on persist.
- **Tests**: orchestrator escalates on refusal (FakeLLM scripted); adapter mapping of `usage` and `refusal` (unit, by stubbing the SDK client); live smoke (`LIVE_LLM=1`) green on `claude-sonnet-5-5`.

## Workflow (`.github/workflows/evals.yml`)
- **Guarantees**: `fake` job on push/PR with the README drift check; `live` job weekly, on dispatch (inputs model/repetitions/judge/cap) and on PRs touching `prompts/**`; skips with a notice when the secret is absent; publishes the report via a PR (`gh`), never a direct commit; artifacts retained 90 days.
- **Tests**: workflow YAML validated by running it (first PR); the `gh` publication step is exercised with `workflow_dispatch` once the secret exists.
