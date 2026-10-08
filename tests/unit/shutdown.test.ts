import { describe, expect, it, vi } from "vitest";
import type { JobHandle } from "../../src/jobs/scheduler";
import { createShutdown } from "../../src/webhook/shutdown";

/** A worker stand-in (008): work it started, drained with a bound — the shape shutdown relies on. */
class FakeDrainable {
  private readonly running = new Set<Promise<unknown>>();
  run(fn: () => Promise<unknown>): void {
    const p = fn().finally(() => this.running.delete(p));
    this.running.add(p);
  }
  async drain(timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((r) => {
      timer = setTimeout(() => r(false), timeoutMs);
    });
    try {
      return await Promise.race([
        Promise.all([...this.running]).then(() => true as const),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

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
    const queue = new FakeDrainable();
    let release!: () => void;
    void queue.run(() =>
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
    const queue = new FakeDrainable();
    // The server's close callback fires only after an in-flight request completed and
    // handed its message to the queue — exactly the SIGTERM-during-upload race.
    const server = {
      close: vi.fn((cb?: (err?: Error) => void) => {
        void queue.run(async () => {
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

  it("a listener that cannot close in time makes the verdict unclean even with an empty queue [Codex P2]", async () => {
    const neverClosing = { close: vi.fn() }; // an upload keeps a request open; close(cb) never fires
    const close = vi.fn(async () => {});
    const shutdown = createShutdown({
      server: neverClosing,
      jobs: [],
      queue: new FakeDrainable(),
      close,
      timeoutMs: 40,
      log: () => {},
    });
    expect(await shutdown()).toBe(false); // entrypoint exits 1: requests were still open
    expect(close).toHaveBeenCalledTimes(1); // resources are still released
  });

  it("a hanging deps.close() (e.g. pool.end on a stalled client) is bounded by the budget too [Codex P2]", async () => {
    const shutdown = createShutdown({
      server: fakeServer(),
      jobs: [],
      queue: new FakeDrainable(),
      close: () => new Promise<void>(() => {}), // never resolves
      timeoutMs: 40,
      log: () => {},
    });
    const t0 = Date.now();
    expect(await shutdown()).toBe(false); // caller exits non-zero instead of hanging forever
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("spends at most ONE budget even when both the queue and the server hang", async () => {
    const queue = new FakeDrainable();
    void queue.run(() => new Promise<void>(() => {})); // never settles
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
    const queue = new FakeDrainable();
    void queue.run(() => new Promise<void>(() => {})); // never settles
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
