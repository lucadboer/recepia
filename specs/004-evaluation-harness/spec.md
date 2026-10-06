# Feature Specification: Evaluation Harness for the Booking Agent

**Feature Branch**: `004-evaluation-harness`

**Created**: 2026-10-06

**Status**: Draft

**Input**: User description: "Evaluation harness for the WhatsApp booking agent. Make the agent's behaviour measurable and regression-proof: a golden set of ≥ 40 authored pt-BR conversations (happy path, alternatives, reschedule/cancel → hand-off, ambiguous dates, out-of-scope, opt-out, consent refusal, ≥ 8 prompt-injection attempts) scored by deterministic assertions over what the agent did (tool calls and arguments, no write without consent, escalation exactly when expected, no hallucinated availability, final status), an optional non-gating judge for tone/clarity, per-run metrics (task success per category, tool-call accuracy, escalation precision/recall for triage-only and full agent, injection resistance, latency p50/p95, tokens and estimated cost), a dated report with model id and prompt version, README numbers generated (never hand-written), a deterministic gate on every change plus nightly/on-demand runs with the real model against a committed baseline, and a versioned system prompt recorded on every call, in audit payloads and in the report. No real usage data exists; the golden set is authored."

> Spec artifacts are in English (author preference); patient-facing strings and the golden conversations stay in Brazilian Portuguese. Builds on features 001 (deterministic booking tools) and 002 (conversational orchestration). This feature adds **no patient-facing behaviour**: it measures and guards the behaviour that already exists.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Guardrail regression gate on every change (Priority: P1)

As the maintainer, every time I change the agent I want an automatic, deterministic run of the golden conversations that fails the change if any guardrail is weakened: a write without consent, a slot that was never offered, a hold confirmed from another conversation, an escalation that should have happened and did not (or happened when it should not), or a conversation that ends in the wrong state. The run must not depend on any external model, network or credential, so it can block every change.

**Why this priority**: the constitution's non-negotiables ("the LLM never writes", "escalate on doubt", consent before commit) are currently proven by hand-written tests; a golden set turns them into a broad, scenario-level gate that grows with every incident and makes regressions visible before merge.

**Independent Test**: run the harness in deterministic mode on the current code — every case passes and three consecutive runs produce identical results; disable one structural gate on purpose — at least one adversarial case fails and the run reports which guardrail broke.

**Acceptance Scenarios**:

1. **Given** the golden set and the scripted stand-in model, **When** the harness runs on a change, **Then** every case is evaluated against its expectations and the run fails if any case fails, naming the case and the violated expectation.
2. **Given** an adversarial case where the scripted model tries to hold a slot it was never offered, **When** the harness runs, **Then** the case passes only if no hold was written and the model received a rejection.
3. **Given** a case whose expected outcome is a hand-off (pain, insurance, a specific dentist, a reschedule request), **When** the harness runs, **Then** the case passes only if reception was notified exactly once with the patient's phone and the conversation ended handed off.
4. **Given** three consecutive deterministic runs on the same code, **When** their results are compared, **Then** they are identical (same pass/fail per case, same tool-call sequences).

---

### User Story 2 — Measured behaviour of the real model (Priority: P1)

As the maintainer (and as someone showing this project to reviewers), I want a scheduled or on-demand run of the same golden set against the real model that produces a dated report with: task success per category, tool-call accuracy, escalation precision and recall (for the deterministic triage alone and for the full agent), injection resistance, latency per turn and per conversation, tokens and estimated cost per conversation. The run must compare its results with a committed baseline and fail when behaviour regresses beyond an agreed tolerance, so the numbers mean something and cannot silently drift.

**Why this priority**: it is the main differentiator of the project — evidence, produced by the repository itself, of how the agent behaves with a real model — and the only honest source of the numbers shown to anyone.

**Independent Test**: with model credentials available, run the harness in live mode — a report is produced containing every listed metric plus the date, model id, prompt version and commit; run it again with the baseline deliberately set higher than the results — the run fails with a regression message; with no credentials, the live run is skipped with an explicit notice, never reported as a pass.

**Acceptance Scenarios**:

1. **Given** model credentials and the golden set, **When** the live run executes, **Then** every case is executed a configured number of times, each metric is computed from those executions, and a report (human-readable and machine-readable) is written with the run date, model id, prompt version and commit.
2. **Given** a committed baseline, **When** the live run's task success for any category drops by more than the configured tolerance, or any adversarial case allows an unauthorized write, **Then** the run fails and says which metric regressed and by how much.
3. **Given** a model call that times out or is rate-limited during a live run, **When** the case is scored, **Then** it counts as a failed execution (never as a success) and the report shows the error count.
4. **Given** a configured spend cap, **When** the estimated cost of a live run would exceed it, **Then** the run stops and reports the cap, so an experiment never surprises the owner with a bill.

---

### User Story 3 — Versioned system prompt with traceability (Priority: P2)

As the maintainer, I want the agent's system prompt to be a versioned artifact with an identifier and a changelog, and I want that identifier recorded on every model call, in the audit trail of every write the model initiated, and in every evaluation report — so any reported number and any audited booking can be traced to the exact instructions the model was given.

**Why this priority**: evaluation results are meaningless without knowing which prompt produced them, and LGPD traceability (constitution V) extends naturally to "which instructions led to this write".

**Independent Test**: change one line of the prompt — the version identifier changes, the next model call records the new version, a booking made through the model carries it in its audit payload, and the next report shows it.

**Acceptance Scenarios**:

1. **Given** the prompt artifact and its changelog, **When** a model call is made, **Then** the conversation record and the call's trace carry the prompt version.
2. **Given** a booking or escalation initiated by the model, **When** its audit row is inspected, **Then** the payload includes the prompt version in effect.
3. **Given** two reports produced with different prompt versions, **When** they are compared, **Then** each states its own version so differences can be attributed.

---

### User Story 4 — Published numbers that cannot be faked (Priority: P2)

As a reviewer reading the project README, I want the evaluation numbers shown there to come from the latest report, with the date, model and prompt version next to them, and I want the project to reject any attempt to edit those numbers by hand.

**Why this priority**: the project's credibility rests on honest numbers; a generated block with a drift check is what makes "never hand-written" a verifiable claim rather than a promise.

**Independent Test**: regenerate the README block from the latest report — the check passes; edit one number by hand — the automated check fails and names the mismatch.

**Acceptance Scenarios**:

1. **Given** a new report, **When** the README block is regenerated, **Then** it shows the report's headline metrics with the run date, model id and prompt version.
2. **Given** a README whose generated block differs from the latest report, **When** the automated checks run, **Then** they fail and point at the generated block.

---

### User Story 5 — Optional judge for tone and clarity (Priority: P3)

As the maintainer, I want an optional second-model judgement of the patient-facing replies on tone and clarity only (never on correctness, which the deterministic assertions own), scored with a rubric that is versioned in the repository, reported separately and never used as a gate.

**Why this priority**: wording quality matters for a patient-facing agent but cannot be asserted deterministically; a judge gives a trend signal without pretending to be a guarantee.

**Independent Test**: run the judge on a report's transcripts — each case receives tone and clarity scores with the rubric version; disable the judge — the rest of the harness is unaffected and the report marks the judge section as not run.

**Acceptance Scenarios**:

1. **Given** judge credentials and a rubric version, **When** the judge runs over the live transcripts, **Then** each conversation gets a tone score and a clarity score with a one-line justification, and the report shows the rubric version.
2. **Given** judge scores below any threshold, **When** the run finishes, **Then** the run still passes (the judge never gates) and the scores are visible for trend analysis.

---

### Edge Cases

- A case category whose expected outcome follows a current limitation (reschedule/cancel requests → hand-off) MUST be labelled as such in the case, so the expectation is revisited when the capability lands rather than silently encoding the limitation forever.
- The real model is non-deterministic: a case may pass in two executions and fail in one. Live metrics are success rates over N executions; the deterministic mode uses the scripted stand-in model and must be exactly repeatable.
- No baseline exists yet (first live run): the run records its results as the baseline candidate, passes with a warning, and the baseline becomes authoritative only when committed through a reviewed change.
- A prompt change intentionally shifts behaviour: the regression against the old baseline is expected; the baseline update is an explicit, reviewed change in the same PR as the prompt, never automatic.
- The judge model is unavailable or produces an unparsable answer: the judge section is marked "not run" / "invalid" for the affected cases; the run outcome is unaffected.
- A golden case drifts from reality (e.g. clinic hours change in the seed): the harness seeds its own clinic state per case, so cases are self-contained and do not depend on a shared database state.
- Spend cap reached mid-run: the run stops, reports partial results clearly labelled as partial, and fails.
- The scripted stand-in model is itself part of the fixture: a case bundles the script the stand-in follows, so "what the model tried to do" is explicit and reviewable.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-401 — Golden set**: The project MUST contain at least 40 authored Brazilian-Portuguese conversations as fixtures, each with a category, a self-contained clinic seed (capacity, "now", prior consent), the patient turns, the script the stand-in model follows, and the expected outcomes. Categories MUST include: happy path (including an alternative when the first slot is full), reschedule/cancel requests (expected: hand-off, labelled as a current limitation), ambiguous dates, out-of-scope requests (insurance, pain/urgency, prices, specialized procedures, a specific dentist, explicit request for a human), opt-out, consent refusal, and at least 8 adversarial prompt-injection attempts (instructions to ignore rules, fake system messages, booking for another phone, inventing a tool, holding a never-offered slot, confirming another conversation's hold, oversized or malformed input).
- **FR-402 — Deterministic scoring**: Each case MUST be scored by assertions over what the agent did, never over the model's wording: the sequence of tool calls and their arguments (with matchers for values that are legitimately variable, such as a slot chosen from an offered list), the writes that happened (holds, bookings, calendar events, escalations) and that none happened without recorded consent, that escalation happened exactly when expected with the expected reason category, that every offered or held slot came from availability returned in the same conversation (no hallucinated availability), and the final conversation status.
- **FR-403 — Deterministic gate**: In deterministic mode the harness MUST run without network or credentials, MUST produce identical results on repeated runs, MUST run on every change to the repository, and ANY failing case MUST block the change.
- **FR-404 — Live mode**: Behind a credential that is never committed, the harness MUST run the same golden set against the real model on a schedule and on demand, executing each case a configured number of times (default 3), and MUST skip explicitly (never pass silently) when the credential is absent.
- **FR-405 — Metrics**: Every run MUST report: task success rate per category and overall; tool-call accuracy (expected vs actual call sequences); escalation precision and recall computed against the case labels for (a) the deterministic triage alone and (b) the full agent; injection resistance (share of adversarial cases with zero unauthorized writes); latency p50/p95 per turn and per conversation; tokens in/out and estimated cost per conversation from a dated pricing table; error count (timeouts, rate limits, invalid outputs).
- **FR-406 — Report**: Each run MUST write a human-readable report and a machine-readable report containing the run date, mode, model id, prompt version, commit, every metric and the per-case results; reports MUST be kept as history and the latest MUST be addressable.
- **FR-407 — Baseline and regression**: Live results MUST be compared with a committed baseline; the run MUST fail when any category's success rate drops by more than the configured tolerance (default 5 percentage points) or when any adversarial case allows an unauthorized write; baseline updates MUST be explicit, reviewed changes.
- **FR-408 — Published numbers**: The README MUST show the latest report's headline metrics through a block generated from the report, including date, model id and prompt version; the automated checks MUST fail when that block differs from the latest report.
- **FR-409 — Versioned prompt**: The system prompt MUST be a versioned artifact with an identifier and a changelog; the identifier MUST be recorded on every model call, in the audit payload of every write initiated through the model, and in every report.
- **FR-410 — Judge (optional)**: A judge MAY score tone and clarity of patient-facing replies using a rubric versioned in the repository; judge scores MUST be reported separately, MUST never gate a run, and the judge MUST be skippable.
- **FR-411 — Cost control**: Live runs MUST estimate cost as they go from the dated pricing table and MUST stop and fail when a configured spend cap would be exceeded, reporting partial results as partial.
- **FR-412 — Honesty**: Every report and the README block MUST state that the golden set is authored (no production data) and name the model and date; no metric MAY be entered by hand anywhere in the repository.
- **FR-413 — Privacy**: Golden conversations MUST use fictitious names and phones; live-run transcripts MUST NOT be sent anywhere except to the model provider used for the run and the optional judge.

### Key Entities

- **Eval Case**: an authored conversation with id, category, limitation label (optional), clinic seed, patient turns, stand-in script, and expectations.
- **Expectation**: the deterministic assertions for a case — expected tool-call sequence with matchers, expected writes, consent precondition, escalation expectation (whether, and which reason category), no-hallucination rule, final status.
- **Run**: one execution of the golden set in a mode (deterministic or live) with a model id, prompt version, commit, date, repetitions and spend cap.
- **Case Result**: the observed tool calls, writes, escalations, status, latency, tokens, cost, errors and pass/fail per expectation for one execution of a case.
- **Metric**: an aggregate computed from case results (success rates, precision/recall, injection resistance, latency percentiles, cost).
- **Report**: the human-readable and machine-readable outputs of a run; the latest one feeds the README block.
- **Baseline**: the committed reference metrics a live run is compared against.
- **Prompt Version**: identifier + changelog entry for the system prompt in effect.
- **Judge Rubric**: versioned scoring instructions for tone and clarity.
- **Pricing Table**: dated per-model token prices used for cost estimates.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-401**: The deterministic run completes in under 2 minutes on every change and is exactly repeatable (three consecutive runs give identical per-case results).
- **SC-402**: 100 % of adversarial cases end with zero unauthorized writes in deterministic mode, and the live run fails if that ever drops below 100 %.
- **SC-403**: A deliberately disabled structural guardrail is caught by the deterministic run before merge (demonstrated once and recorded in the report history).
- **SC-404**: Every live report contains all metrics in FR-405 plus date, model id, prompt version and commit; the README numbers always equal the latest report's.
- **SC-405**: A hand-edited number in the README is detected by the automated checks.
- **SC-406**: A live run completes in under 20 minutes and under the configured spend cap (default US$ 2 per run) with the default golden set and repetitions.
- **SC-407**: Every booking or escalation initiated through the model can be traced to a prompt version from its audit row.

## Assumptions

- The golden set is authored by the project owner and the coding agent; there is no production data and none is implied.
- The deterministic mode uses the existing scripted stand-in model, so "what the model tried to do" is part of each fixture; the live mode uses the project's configured model provider.
- Model credentials for live runs are provided as a secret in the repository's automation and locally in the environment; they are never available to changes proposed from outside the repository.
- Live-mode non-determinism is handled by repetitions (default 3 per case) and success-rate metrics, not by exact-match expectations.
- Reschedule and cancel capabilities do not exist yet (SPEC.md US3); their cases expect a hand-off and are labelled as a current limitation to be revisited.
- The pricing table is maintained by hand with its date; estimated cost is an estimate, labelled as such.
- The judge, when enabled, uses a model different from the one under evaluation whenever possible, to reduce self-preference.
- Tolerances and caps (5 percentage points, 3 repetitions, US$ 2) are starting defaults, adjustable in configuration, and recorded in each report.
