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

  it("drains work enqueued by a request that finishes WHILE the listener is closing (no lost ack)", async () => {
    const order: string[] = [];
    const queue = new PerKeyQueue();
    // The server's close callback fires only after an in-flight request completed and
    // handed its message to the queue — exactly the SIGTERM-during-upload race.
    const server = {
      close: vi.fn((cb?: (err?: Error) => void) => {
        void queue.run("late", async () => {
          await new Promise((r) => setTimeout(r, 10));
          order.push("late-turn.done");
        });
        cb?.();
      }),
    };
    const close = vi.fn(async () => {
      order.push("deps.close");
    });
    const shutdown = createShutdown({
      server,
      jobs: [],
      queue,
      close,
      timeoutMs: 1000,
      log: () => {},
    });
    expect(await shutdown()).toBe(true);
    expect(order).toEqual(["late-turn.done", "deps.close"]);
  });

  it("spends at most ONE budget even when both the queue and the server hang", async () => {
    const queue = new PerKeyQueue();
    void queue.run("p", () => new Promise<void>(() => {})); // never settles
    const neverClosing = { close: vi.fn() }; // never calls back
    const shutdown = createShutdown({
      server: neverClosing,
      jobs: [],
      queue,
      close: async () => {},
      timeoutMs: 60,
      log: () => {},
    });
    const t0 = Date.now();
    expect(await shutdown()).toBe(false);
    expect(Date.now() - t0).toBeLessThan(60 * 2); // not 2x the budget
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
