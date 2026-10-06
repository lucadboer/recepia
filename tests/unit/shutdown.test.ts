import { describe, expect, it, vi } from "vitest";
import type { JobHandle } from "../../src/jobs/scheduler";
import { PerKeyQueue } from "../../src/webhook/per-key-queue";
import { createShutdown } from "../../src/webhook/shutdown";

function fakeServer() {
  const close = vi.fn((cb?: (err?: Error) => void) => {
    cb?.();
  });
  return { close };
}
function fakeJob(name: string): JobHandle & { stop: ReturnType<typeof vi.fn<() => void>> } {
  return { name, running: false, stop: vi.fn<() => void>() };
}

describe("createShutdown — graceful stop (T246)", () => {
  it("stops jobs, closes the server, drains in-flight work, closes deps — in that order, once", async () => {
    const order: string[] = [];
    const server = fakeServer();
    server.close.mockImplementation((cb?: (err?: Error) => void) => {
      order.push("server.close");
      cb?.();
    });
    const job = fakeJob("outbox");
    job.stop.mockImplementation(() => order.push("job.stop"));
    const queue = new PerKeyQueue();
    let release!: () => void;
    void queue.run("p", () =>
      new Promise<void>((r) => (release = r)).then(() => order.push("work.done")),
    );
    const close = vi.fn(async () => {
      order.push("deps.close");
    });
    await new Promise((r) => setTimeout(r, 0)); // let the queued task start (it holds `release`)

    const shutdown = createShutdown({
      server,
      jobs: [job],
      queue,
      close,
      timeoutMs: 1000,
      log: () => {},
    });
    const p1 = shutdown();
    const p2 = shutdown(); // idempotent: same in-flight promise
    expect(p2).toBe(p1);
    release();
    expect(await p1).toBe(true);

    expect(order).toEqual(["job.stop", "server.close", "work.done", "deps.close"]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it("returns false when in-flight work does not drain within the budget, but still closes deps", async () => {
    const queue = new PerKeyQueue();
    void queue.run("p", () => new Promise<void>(() => {})); // never settles
    const close = vi.fn(async () => {});
    const shutdown = createShutdown({
      server: fakeServer(),
      jobs: [fakeJob("outbox")],
      queue,
      close,
      timeoutMs: 30,
      log: () => {},
    });
    expect(await shutdown()).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
