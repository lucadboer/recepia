import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyError } from "../../evals/lib/runner";
import { currentCommit, readBaseline } from "../../evals/run";

describe("classifyError — provider failures are counted by kind, never scored", () => {
  it.each([
    [{ name: "APIConnectionTimeoutError", message: "timed out" }, "timeout"],
    [{ name: "APIConnectionError", message: "ECONNRESET" }, "connection"],
    [{ status: 429, message: "rate limited" }, "rate_limit"],
    [{ status: 503, message: "overloaded" }, "provider"],
    [{ status: 400, message: "bad request" }, "infrastructure"],
    [new Error("FakeLLM: script exhausted"), "infrastructure"],
  ])("%j → %s", (err, kind) => {
    expect(classifyError(err).kind).toBe(kind);
  });

  it("keeps the message, also for non-Error throwables", () => {
    expect(classifyError("boom")).toEqual({ kind: "infrastructure", message: "boom" });
  });
});

describe("readBaseline", () => {
  it("returns null when missing, the object when valid, and rejects a non-baseline file", () => {
    const dir = mkdtempSync(join(tmpdir(), "recepia-baseline-"));
    expect(readBaseline(join(dir, "nope.json"))).toBeNull();
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ metrics: {} }));
    expect(() => readBaseline(bad)).toThrow(/not a baseline/);
    const good = join(dir, "good.json");
    writeFileSync(
      good,
      JSON.stringify({
        model: "m",
        promptVersion: "v001+abcdef0",
        date: "d",
        commit: "c",
        metrics: { taskSuccess: { overall: 1, byCategory: { happy_path: 1 } } },
      }),
    );
    expect(readBaseline(good)?.model).toBe("m");
  });
});

describe("currentCommit", () => {
  it("prefers GITHUB_SHA (short) in CI and otherwise asks git", () => {
    expect(currentCommit({ GITHUB_SHA: "abcdef1234567890" })).toBe("abcdef1");
    expect(currentCommit({})).toMatch(/^[0-9a-f]{7,}$|^unknown$/);
  });
});
