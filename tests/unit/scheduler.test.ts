import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schedule } from "../../src/jobs/scheduler";

describe("schedule — in-process periodic job with an in-flight guard (T245)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the job every interval", async () => {
    const run = vi.fn(async () => {});
    const h = schedule({ name: "t", everyMs: 1000, run });
    await vi.advanceTimersByTimeAsync(3000);
    expect(run).toHaveBeenCalledTimes(3);
    h.stop();
  });

  it("never overlaps: a slow run skips the ticks it covers", async () => {
    let release: () => void = () => {};
    const run = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((r) => {
            release = r;
          }),
      )
      .mockResolvedValue(undefined);
    const h = schedule({ name: "t", everyMs: 1000, run });
    await vi.advanceTimersByTimeAsync(3500); // 3 ticks while the first run is still in flight
    expect(run).toHaveBeenCalledTimes(1);
    expect(h.running).toBe(true);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(h.running).toBe(false);
    h.stop();
  });

  it("reports a failing run to onError and keeps scheduling", async () => {
    const boom = new Error("boom");
    const run = vi.fn().mockRejectedValueOnce(boom).mockResolvedValue(undefined);
    const onError = vi.fn();
    const h = schedule({ name: "outbox", everyMs: 1000, run }, onError);
    await vi.advanceTimersByTimeAsync(2000);
    expect(onError).toHaveBeenCalledWith("outbox", boom);
    expect(run).toHaveBeenCalledTimes(2);
    h.stop();
  });

  it("a run() that throws SYNCHRONOUSLY is reported too and does not kill the schedule", async () => {
    const boom = new Error("sync boom");
    const run = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => {
        throw boom;
      })
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const h = schedule({ name: "sweep", everyMs: 1000, run }, onError);
    await vi.advanceTimersByTimeAsync(2000);
    expect(onError).toHaveBeenCalledWith("sweep", boom);
    expect(run).toHaveBeenCalledTimes(2);
    expect(h.running).toBe(false);
    h.stop();
  });

  it("stop() clears the interval — no further runs", async () => {
    const run = vi.fn(async () => {});
    const h = schedule({ name: "t", everyMs: 1000, run });
    await vi.advanceTimersByTimeAsync(1000);
    h.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("startJobs — reminder jobs (007)", () => {
  it("registers the reminder and unconfirmed-notice jobs only when reminder settings are given", async () => {
    const { startJobs, stopJobs } = await import("../../src/jobs/scheduler");
    const deps = {} as never; // no job runs before stop (first runs are delayed)
    const without = startJobs(deps);
    const withReminders = startJobs(deps, undefined, {
      leadMs: 24 * 3_600_000,
      noticeLeadMs: 3 * 3_600_000,
      template: null,
    });
    try {
      expect(without.map((j) => j.name)).not.toContain("reminders");
      expect(withReminders.map((j) => j.name)).toEqual(
        expect.arrayContaining(["reminders", "unconfirmed-notice", "outbox"]),
      );
    } finally {
      stopJobs(without);
      stopJobs(withReminders);
    }
  });
});

describe("startJobs — hold sweep and abandoned events (008 review)", () => {
  it("runs the abandoned-event cleanup as its own job, so a stalled Calendar call never blocks hold expiry", async () => {
    const { startJobs, stopJobs } = await import("../../src/jobs/scheduler");
    const jobs = startJobs({} as never);
    try {
      expect(jobs.map((j) => j.name)).toEqual(
        expect.arrayContaining(["hold-sweep", "abandoned-events"]),
      );
    } finally {
      stopJobs(jobs);
    }
  });
});
