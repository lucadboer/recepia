# Implementation Plan: Evaluation Harness for the Booking Agent

**Branch**: `phase-2-evals` (feature `004-evaluation-harness`) | **Date**: 2026-10-06 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/004-evaluation-harness/spec.md`

## Summary
Add an evaluation harness that runs an authored golden set of pt-BR conversations through the real orchestrator (`handleInbound`) against real Postgres with fake Calendar/WhatsApp, scores each case by deterministic assertions over tool calls, writes, escalations and final status, and reports metrics (success per category, tool-call accuracy, escalation precision/recall for triage-only and full agent, injection resistance, latency, tokens/cost). Two modes share everything except the `LLMPort`: deterministic (scripted `FakeLLM`, every push, any failure blocks) and live (the production model, weekly / on demand / on prompt change, compared with a committed baseline). The system prompt becomes a versioned file whose id is recorded on every call, in audit payloads and in reports; the README shows the latest numbers through a generated block with a drift check. As a prerequisite the production model moves from `claude-sonnet-4-6` to `claude-sonnet-5-5` (owner decision), which is a small adapter migration validated live.

## Technical Context
- **Language/Version**: TypeScript on Node 24 (engines ≥ 22.12), ESM, `tsx` for scripts.
- **Primary Dependencies**: existing only — `@anthropic-ai/sdk` (adapter), `pg`, Vitest 5, Biome. **No new dependencies** (fixtures are JSON validated by a hand-written checker; the judge calls the SDK directly). `gh` CLI in workflows for the report PR.
- **Storage**: PostgreSQL (the normal schema; the harness truncates mutable tables between cases, same as the test suite). Fixtures, reports, baseline, pricing and prompts are files in the repo.
- **Testing**: Vitest unit tests for loader/validator, matchers, metrics, report rendering, README block and prompt loader; integration tests running a handful of cases end-to-end through the runner against Postgres; the live adapter change is verified by the existing `tests/live` (`LIVE_LLM=1`).
- **Target Platform**: local dev + GitHub Actions (ubuntu, postgres:16 service).
- **Project Type**: CLI scripts (`evals/`) + small changes in `src/` (prompt versioning, usage/refusal on `LLMPort`, model migration).
- **Performance Goals**: deterministic run < 2 min (SC-401); live run < 20 min and under its cap (SC-406; US$ 0.75 / 1 repetition by default since the 2026-10-08 amendment), sequential cases with TRUNCATE isolation (≈ 135 conversations × ~5 s).
- **Constraints**: no network/credentials in deterministic mode; numbers never hand-written; secrets only in repository automation; patient data fictitious.
- **Scale/Scope**: ≥ 40 cases (≥ 8 adversarial); one repo, one clinic.

## Constitution Check
| Principle | Status | Compliance |
|---|---|---|
| I Test-First | ✅ | Harness modules (loader, matchers, metrics, report, README block, prompt loader, pricing) are unit-tested RED→GREEN; the runner has an integration test over real cases; the model migration keeps the existing `tests/live` green. The golden set itself is the scenario-level test of the agent. |
| II LLM Never Writes | ✅ | The harness only observes (`FakeMessaging`/`FakeCalendar`, DB reads); adversarial cases are the regression proof that the gates hold. The live mode changes only the `LLMPort` implementation. |
| III Simplicity/YAGNI | ✅ | No new runtime dependency; fixtures are plain JSON; one new optional field on `LLMPort` results (`usage`) and one optional `Deps.promptVersion` — both with two consumers (adapter + fake; tools + report). Judge is a single script, off by default. |
| IV Escalate on Doubt | ✅ | Escalation precision/recall is measured; refusal from the model (`stop_reason: refusal`) becomes an escalation, never a silent empty reply. |
| V Traceability/LGPD | ✅ | Prompt version recorded in audit payloads of model-initiated writes; fixtures use fictitious phones/names; transcripts only go to the model provider (and the optional judge). |

Gate: **pass** (no violations to justify).

## Project Structure

### Documentation (this feature)
```text
specs/004-evaluation-harness/
├── plan.md              # This file
├── research.md          # Phase 0: decisions (model migration, case format, metrics, prompt versioning, CI)
├── data-model.md        # Phase 1: Eval Case / Expectation / Run / Result / Report / Baseline / Prompt Version
├── quickstart.md        # Phase 1: how to run fake/live/readme/judge and what to expect
├── contracts/
│   └── eval-harness.md  # Case schema, matchers, runner CLI, report schema, README block, prompt artifact
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)
```text
evals/
├── cases/                 # golden set, one JSON file per case (>= 40; >= 8 adversarial)
├── lib/
│   ├── case-schema.ts     # types + hand-written validator for case files
│   ├── script.ts          # compiles a case's llmScript into FakeLLM turns (placeholders: $offeredSlot, $holdId, ...)
│   ├── runner.ts          # runs one case: seed DB, build deps, drive handleInbound per patient turn, collect observations
│   ├── assertions.ts      # deterministic scoring of observations against expectations
│   ├── metrics.ts         # success per category, tool-call accuracy, precision/recall, injection resistance, latency, cost
│   ├── pricing.ts         # dated pricing table lookup
│   ├── report.ts          # latest.json / latest.md rendering, baseline comparison
│   ├── readme-block.ts    # generate / check the README block
│   └── judge.ts           # optional tone/clarity judge (different model), rubric-versioned
├── judge/rubric.v1.md
├── pricing.json           # dated per-model prices (USD per MTok)
├── baseline.json          # committed reference metrics (live)
├── reports/
│   ├── latest.json
│   └── latest.md
└── run.ts                 # CLI: --mode fake|live --repetitions N --model ID --cap-usd X --judge --case <id>
prompts/
├── system/v001.md         # the versioned system prompt (static block)
└── CHANGELOG.md
src/
├── agent/system-prompt.ts   # loads prompts/system/*.md, computes version id, returns { text, version }
├── agent/orchestrator.ts    # passes promptVersion to tools (Deps) and the trace; refusal -> escalation
├── ports/llm-port.ts        # LlmTurnResult.usage, stopReason "refusal", LlmTurnInput.promptVersion
├── adapters/llm/anthropic-llm.ts  # claude-sonnet-5-5, thinking between_tools, effort low, usage, refusal handling
├── adapters/fakes/fake-llm.ts     # usage zeros; optional per-turn latency
├── deps.ts                  # promptVersion?: string
└── tools/{hold-slot,confirm-booking,escalate-to-human}.ts  # audit payload += promptVersion when present
tests/
├── unit/evals-*.test.ts     # schema, script compiler, assertions, metrics, report, readme block, pricing, prompt loader
└── integration/evals-runner.test.ts  # a few real cases through the runner (fake mode) + the README check
.github/workflows/evals.yml  # fake on push/PR (+ README drift check); live weekly / dispatch / PRs labelled live-evals (subset) -> report PR for full runs
```

**Structure Decision**: a self-contained `evals/` directory (fixtures + library + CLI) that imports the application through its public entry points (`handleInbound`, ports, fakes, repositories) — the same surface the integration tests use. No application code depends on `evals/`.

## Complexity Tracking
No constitution violations; nothing to justify.

## Phases
- **Phase 0 (research.md)**: resolve the model migration details, case/matcher format, isolation strategy, metric definitions, prompt-version scheme, README block + drift check, CI publication flow, judge.
- **Phase 1 (design)**: data-model.md, contracts/eval-harness.md, quickstart.md; CLAUDE.md context pointer.
- **Phase 2 (/speckit-tasks)**: ordered tasks — model migration first (prerequisite, live-validated), then prompt versioning, `usage`/refusal on the port, harness library (TDD), golden set, CLI, workflow, README block, baseline.
