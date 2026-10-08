import { describe, expect, it } from "vitest";
import { type EvalCase, validateCase } from "../../evals/lib/case-schema";
import {
  DEFAULT_CAP_USD,
  DEFAULT_LIVE_REPETITIONS,
  isSubsetRun,
  main,
  parseArgs,
  REPORTS_DIR,
  reportsDirFor,
  SUBSET_REPORTS_DIR,
  selectCases,
} from "../../evals/run";

// 004 amendment (2026-10-08): live runs must be cheap and targeted — a comma-separated case list,
// repeatable categories, 1 repetition and a US$ 0.75 cap by default, and a partial run never
// overwrites the published report (the README block reads it).

function makeCase(id: string, category: string): EvalCase {
  return validateCase({
    id,
    category,
    title: id,
    seed: { now: "2026-06-15T12:00:00Z", capacity: [], consent: "opted_in" },
    patient: { phone: "+5531900000101" },
    turns: [{ text: "oi" }],
    llmScript: [[{ text: "x" }]],
    labels: { shouldEscalate: false },
    expect: { status: "active", writes: { bookings: 0, calendarEvents: 0 } },
  });
}

const all = [
  makeCase("happy-01", "happy_path"),
  makeCase("happy-02", "happy_path"),
  makeCase("inj-01", "injection"),
  makeCase("optout-03", "opt_out"),
];

describe("live defaults are cheap (owner budget, 2026-10-08)", () => {
  it("one repetition and a US$ 0.75 cap unless the caller asks for more", () => {
    expect(DEFAULT_LIVE_REPETITIONS).toBe(1);
    expect(DEFAULT_CAP_USD).toBe(0.75);
    const a = parseArgs(["--mode", "live"]);
    expect(a.repetitions).toBe(1);
    expect(a.capUsd).toBe(0.75);
  });

  it("the CI environment and explicit flags still override the defaults", () => {
    const fromEnv = parseArgs(["--mode", "live"], { EVALS_REPETITIONS: "3", EVALS_CAP_USD: "2" });
    expect(fromEnv.repetitions).toBe(3);
    expect(fromEnv.capUsd).toBe(2);
    const fromFlags = parseArgs(["--mode", "live", "--repetitions", "2", "--cap-usd", "0.1"]);
    expect(fromFlags.repetitions).toBe(2);
    expect(fromFlags.capUsd).toBe(0.1);
  });
});

describe("--case accepts a list and --category repeats", () => {
  it("parses a comma-separated list, trimming blanks and duplicates", () => {
    expect(parseArgs(["--case", "happy-01, inj-01,,happy-01"]).caseIds).toEqual([
      "happy-01",
      "inj-01",
    ]);
  });

  it("an empty list is an error, never a silent full (paid) run", () => {
    expect(() => parseArgs(["--case", " , ,"])).toThrow(/--case/);
  });

  it("collects every --category", () => {
    expect(parseArgs(["--category", "injection", "--category", "opt_out"]).categories).toEqual([
      "injection",
      "opt_out",
    ]);
  });

  it("rejects an unknown category at parse time", () => {
    expect(() => parseArgs(["--category", "nope"])).toThrow(/--category/);
  });

  it("refuses --write-baseline on any subset (cases or categories)", () => {
    expect(() =>
      parseArgs(["--mode", "live", "--write-baseline", "--category", "injection"]),
    ).toThrow(/whole golden set/);
    expect(() => parseArgs(["--mode", "live", "--write-baseline", "--case", "a,b"])).toThrow(
      /whole golden set/,
    );
  });
});

describe("selectCases", () => {
  it("returns the whole set when nothing is selected", () => {
    expect(selectCases(all, parseArgs([])).map((c) => c.id)).toEqual(all.map((c) => c.id));
  });

  it("is the union of the listed ids and the listed categories, in golden-set order", () => {
    const args = parseArgs(["--case", "optout-03", "--category", "happy_path"]);
    expect(selectCases(all, args).map((c) => c.id)).toEqual(["happy-01", "happy-02", "optout-03"]);
  });

  it("fails loudly on an id that does not exist (a typo must not silently shrink the run)", () => {
    expect(() => selectCases(all, parseArgs(["--case", "happy-01,typo-99"]))).toThrow(/typo-99/);
  });

  it("fails when a category selects nothing", () => {
    expect(() => selectCases(all, parseArgs(["--category", "consent_refusal"]))).toThrow(
      /consent_refusal/,
    );
  });
});

describe("partial runs never overwrite the published report", () => {
  it("a full run writes the published report, a subset writes beside it", () => {
    expect(isSubsetRun(parseArgs(["--mode", "live"]))).toBe(false);
    expect(reportsDirFor(parseArgs(["--mode", "live"]))).toBe(REPORTS_DIR);
    const subset = parseArgs(["--mode", "live", "--category", "injection"]);
    expect(isSubsetRun(subset)).toBe(true);
    expect(reportsDirFor(subset)).toBe(SUBSET_REPORTS_DIR);
    expect(SUBSET_REPORTS_DIR).not.toBe(REPORTS_DIR);
  });

  it("an unknown id is reported as a usage error before any database is touched", async () => {
    const log: string[] = [];
    const io = { env: {}, log: (l: string) => log.push(l), error: (l: string) => log.push(l) };
    expect(await main(["--case", "does-not-exist"], io)).toBe(2);
    expect(log.join("\n")).toMatch(/does-not-exist/);
  });
});
