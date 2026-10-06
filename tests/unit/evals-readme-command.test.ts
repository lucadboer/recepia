import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { END_MARKER, START_MARKER } from "../../evals/lib/readme-block";
import { HONESTY_LINE } from "../../evals/lib/report";
import { parseArgs, readmeCommand } from "../../evals/run";

// T445 — the `readme [--check]` subcommand over temporary files (no repository README touched).

function setup(reportJson?: string): { readme: string; report: string } {
  const dir = mkdtempSync(join(tmpdir(), "recepia-readme-"));
  const readme = join(dir, "README.md");
  writeFileSync(readme, `# x\n\n${START_MARKER}\nstale\n${END_MARKER}\n\nend\n`);
  const report = join(dir, "latest.json");
  if (reportJson !== undefined) writeFileSync(report, reportJson);
  return { readme, report };
}

const io = () => {
  const lines: string[] = [];
  return {
    io: { env: {}, log: (l: string) => lines.push(l), error: (l: string) => lines.push(l) },
    lines,
  };
};

describe("readmeCommand", () => {
  it("without a live report writes the honest placeholder; --check then passes; a hand edit fails", () => {
    const paths = setup();
    const a = io();
    expect(readmeCommand(parseArgs(["readme"]), a.io, paths)).toBe(0);
    const written = readFileSync(paths.readme, "utf8");
    expect(written).toMatch(/No live evaluation published yet/);
    expect(written).toContain(HONESTY_LINE);
    expect(written).not.toContain("stale");
    expect(written.endsWith("\n\nend\n")).toBe(true);
    expect(readmeCommand(parseArgs(["readme", "--check"]), io().io, paths)).toBe(0);
    expect(readmeCommand(parseArgs(["readme"]), io().io, paths)).toBe(0); // idempotent, "already up to date"

    writeFileSync(paths.readme, written.replace("No live evaluation", "Perfect"));
    const b = io();
    expect(readmeCommand(parseArgs(["readme", "--check"]), b.io, paths)).toBe(1);
    expect(b.lines.join("\n")).toMatch(/differs/);
  });

  it("renders the live report's numbers and refuses a report that is not a live one", () => {
    const live = {
      schemaVersion: 1,
      mode: "live",
      model: "claude-sonnet-5-5",
      promptVersion: "v001+c9e9f07",
      commit: "abc1234",
      date: "2026-10-06T12:00:00.000Z",
      durationMs: 1,
      repetitions: 3,
      capUsd: 5,
      partial: false,
      spentUsd: 1,
      judge: { enabled: false },
      honesty: HONESTY_LINE,
      summary: { cases: 45, executions: 135, passed: 135, failed: 0, errors: 0 },
      metrics: {
        taskSuccess: { overall: 1, byCategory: { happy_path: 1 } },
        toolCallAccuracy: 1,
        escalation: { triage: { precision: 1, recall: 0.6 }, agent: { precision: 1, recall: 1 } },
        injectionResistance: 1,
        latency: { turnP50Ms: 1, turnP95Ms: 2, conversationP50Ms: 3, conversationP95Ms: 4 },
        cost: {
          perConversationUsd: 0.01,
          totalUsd: 1,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        errors: { total: 0, byKind: {} },
      },
      baseline: null,
      cases: [],
    };
    const paths = setup(JSON.stringify(live));
    expect(readmeCommand(parseArgs(["readme"]), io().io, paths)).toBe(0);
    expect(readFileSync(paths.readme, "utf8")).toContain("claude-sonnet-5-5");

    const fake = setup(JSON.stringify({ ...live, mode: "fake" }));
    expect(() => readmeCommand(parseArgs(["readme"]), io().io, fake)).toThrow(/live report/);
  });

  it("fails when the README has no marker pair", () => {
    const paths = setup();
    writeFileSync(paths.readme, "# no markers\n");
    const a = io();
    expect(readmeCommand(parseArgs(["readme", "--check"]), a.io, paths)).toBe(1);
    expect(a.lines.join("\n")).toMatch(/marker/);
    expect(() => readmeCommand(parseArgs(["readme"]), io().io, paths)).toThrow(/marker/);
  });
});
