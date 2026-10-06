# Quickstart: Evaluation Harness

## Prerequisites
```bash
corepack enable && pnpm install
pnpm db:up && pnpm migrate      # Postgres on localhost:5434
```

## Deterministic run (no network, the CI gate)
```bash
pnpm evals:fake                 # runs every case in evals/cases with the scripted FakeLLM
# expected: "N/N cases passed", evals/reports/latest.{json,md} written, exit 0
pnpm evals:fake && pnpm evals:fake   # repeatable: identical per-case results
pnpm evals:fake --case injection-03-never-offered-slot   # one case, verbose assertions
```

## README block
```bash
pnpm evals:readme               # regenerates the block between <!-- evals:start --> and <!-- evals:end -->
pnpm evals:readme --check       # exits 1 if the README block differs from latest.json (CI step)
```

## Live run (costs money; requires the production model credential)
```bash
export ANTHROPIC_API_KEY=...    # never committed
pnpm evals:live                 # claude-sonnet-5-5, 3 repetitions per case, cap US$ 5
pnpm evals:live --model claude-haiku-4-5 --repetitions 1 --cap-usd 2
pnpm evals:live --judge         # adds tone/clarity scores from a different model (claude-opus-5-5)
# expected: report with metrics, model, prompt version, commit; non-zero exit on regression vs evals/baseline.json
```
Without the credential the live command prints a "skipped" notice and exits 0 without writing a report.

## Prompt versioning
```bash
sed -n 1,5p prompts/CHANGELOG.md          # current version and its entry
pnpm vitest run tests/unit/prompt-loader.test.ts
```
Changing `prompts/system/vNNN.md` changes the version id; the next live run (automatic on PRs touching `prompts/**`) reports it, and a regression against the baseline is expected to be reviewed together with a baseline update in the same PR.

## What the suite proves (behaviour, never wording)
1. Every adversarial case ends with zero unauthorized writes (injection resistance = 100 % in fake mode; live run fails otherwise).
2. Happy-path cases book exactly once; "slot full" cases pick an alternative; out-of-scope cases hand off exactly once with the patient's phone.
3. Opt-out and consent refusal never lead to a booking; opt-out cancels queued notifications.
4. Escalation precision/recall is reported for the regex triage alone and for the full agent.
5. README numbers equal `evals/reports/latest.json` — `pnpm evals:readme --check` enforces it.
