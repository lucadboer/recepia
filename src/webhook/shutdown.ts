import { SHUTDOWN_TIMEOUT_MS } from "../config";
import { type JobHandle, stopJobs } from "../jobs/scheduler";
import { log as defaultLog } from "../telemetry/logger";
import type { PerKeyQueue } from "./per-key-queue";

export interface ShutdownOptions {
  server: { close(cb?: (err?: Error) => void): unknown };
  jobs: JobHandle[];
  queue: PerKeyQueue;
  /** Release shared resources (pool, adapters) — called exactly once, last. */
  close: () => Promise<void>;
  /** Budget to drain in-flight turns. Default: SHUTDOWN_TIMEOUT_MS. */
  timeoutMs?: number;
  log?: (msg: string) => void;
}

/**
 * Graceful shutdown (T246): stop the background jobs, stop accepting connections, wait for
 * in-flight inbound turns to finish (bounded), then close deps. Idempotent — repeated
 * signals share the same in-flight promise. Resolves true when everything drained in time.
 */
export function createShutdown(opts: ShutdownOptions): () => Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  const log = opts.log ?? ((m: string) => defaultLog.info({ event: "shutdown" }, m));
  let inProgress: Promise<boolean> | null = null;

  async function run(): Promise<boolean> {
    const deadline = Date.now() + timeoutMs; // ONE budget for the whole sequence
    const remaining = () => Math.max(0, deadline - Date.now());
    log("[shutdown] stopping background jobs and the HTTP listener");
    stopJobs(opts.jobs);
    // 1. Stop accepting and wait for requests already in flight to finish: a webhook body
    //    still uploading can enqueue a turn AFTER an early drain would have returned.
    const closed = new Promise<void>((resolve) => {
      opts.server.close(() => resolve());
    });
    const listenerClosed = await Promise.race([
      closed.then(() => true),
      sleep(remaining()).then(() => false),
    ]);
    // 2. Only now drain the per-phone queue — nothing new can be enqueued anymore.
    const drained = await opts.queue.drain(remaining());
    // 3. Release shared resources last — bounded too: pool.end() waits for checked-out
    //    clients, and a stalled DB operation would otherwise hold the process forever.
    const closedDeps = await Promise.race([
      opts.close().then(() => true),
      sleep(remaining()).then(() => false),
    ]);
    const unfinished = [
      listenerClosed ? null : "requests still open",
      drained ? null : "turns in flight",
      closedDeps ? null : "resources not released",
    ].filter((x): x is string => x !== null);
    const clean = unfinished.length === 0;
    log(clean ? "[shutdown] clean" : `[shutdown] timed out: ${unfinished.join(", ")}`);
    return clean;
  }

  return () => {
    if (!inProgress) inProgress = run();
    return inProgress;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
