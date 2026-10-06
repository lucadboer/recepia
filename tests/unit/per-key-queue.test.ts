import { describe, expect, it } from "vitest";
import { PerKeyQueue } from "../../src/webhook/per-key-queue";

const tick = () => new Promise<void>((r) => setTimeout(r, 5));

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("PerKeyQueue — serialize per key, overlap across keys (T240)", () => {
  it("runs tasks for the SAME key strictly one after another, in order", async () => {
    const q = new PerKeyQueue();
    const log: string[] = [];
    const first = deferred();
    const p1 = q.run("a", async () => {
      log.push("1:start");
      await first.promise;
      log.push("1:end");
      return 1;
    });
    const p2 = q.run("a", async () => {
      log.push("2:start");
      return 2;
    });
    await tick();
    expect(log).toEqual(["1:start"]); // 2 has not started
    first.resolve();
    expect(await p1).toBe(1);
    expect(await p2).toBe(2);
    expect(log).toEqual(["1:start", "1:end", "2:start"]);
  });

  it("lets tasks for DIFFERENT keys overlap", async () => {
    const q = new PerKeyQueue();
    const gateA = deferred();
    const log: string[] = [];
    const pa = q.run("a", async () => {
      log.push("a:start");
      await gateA.promise;
    });
    const pb = q.run("b", async () => {
      log.push("b:start");
    });
    await tick();
    expect(log).toEqual(["a:start", "b:start"]); // b ran while a was blocked
    gateA.resolve();
    await Promise.all([pa, pb]);
  });

  it("a rejected task does not block the next task on the same key", async () => {
    const q = new PerKeyQueue();
    const boom = new Error("boom");
    const p1 = q.run("a", async () => {
      throw boom;
    });
    const p2 = q.run("a", async () => "ok");
    await expect(p1).rejects.toBe(boom);
    expect(await p2).toBe("ok");
  });

  it("tracks in-flight work and drains to zero", async () => {
    const q = new PerKeyQueue();
    const gate = deferred();
    const p = q.run("a", () => gate.promise);
    q.run("a", async () => {});
    expect(q.inFlight).toBe(2); // one running + one queued
    const drained = q.drain(1000);
    gate.resolve();
    await p;
    expect(await drained).toBe(true);
    expect(q.inFlight).toBe(0);
  });

  it("drain(timeout) returns false when work is still pending", async () => {
    const q = new PerKeyQueue();
    const gate = deferred();
    void q.run("a", () => gate.promise);
    expect(await q.drain(20)).toBe(false);
    gate.resolve();
    expect(await q.drain(100)).toBe(true);
  });
});
