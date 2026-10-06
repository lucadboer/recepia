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

  it("stop() clears the interval — no further runs", async () => {
    const run = vi.fn(async () => {});
    const h = schedule({ name: "t", everyMs: 1000, run });
    await vi.advanceTimersByTimeAsync(1000);
    h.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
