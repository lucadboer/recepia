import {
  HOLD_SWEEP_MS,
  OUTBOX_POLL_MS,
  RETENTION_FIRST_RUN_MS,
  RETENTION_INTERVAL_MS,
} from "../config";
import type { Deps } from "../deps";
import { log } from "../telemetry/logger";
import { dispatchOutbox } from "./dispatch-outbox";
import { expireHolds } from "./expire-holds";
import { purgeInactive } from "./retention";

export interface ScheduledJob {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
  /** Also run once this long after start (default: only every `everyMs`). */
  firstRunMs?: number;
}

export interface JobHandle {
  readonly name: string;
  /** True while a run is in flight (ticks that arrive meanwhile are skipped). */
  readonly running: boolean;
  stop(): void;
}

export type JobErrorHandler = (name: string, err: unknown) => void;

const defaultOnError: JobErrorHandler = (name, err) => {
  log.error({ event: "job.failed", job: name, err }, "background job failed");
};

/**
 * Minimal in-process scheduler: setInterval + an in-flight guard so a slow run is never
 * overlapped by the next tick. Errors are reported and never stop the schedule. The
 * timer is unref'd so it alone does not keep the process alive.
 */
export function schedule(job: ScheduledJob, onError: JobErrorHandler = defaultOnError): JobHandle {
  let inFlight = false;
  const tick = () => {
    if (inFlight) return;
    inFlight = true;
    Promise.resolve()
      .then(() => job.run()) // a synchronous throw becomes a rejection, never an uncaught exception
      .catch((err) => onError(job.name, err))
      .finally(() => {
        inFlight = false;
      });
  };
  const timer = setInterval(tick, job.everyMs);
  timer.unref?.();
  const first = job.firstRunMs !== undefined ? setTimeout(tick, job.firstRunMs) : undefined;
  first?.unref?.();
  return {
    name: job.name,
    get running() {
      return inFlight;
    },
    stop: () => {
      clearInterval(timer);
      if (first) clearTimeout(first);
    },
  };
}

/** The production background jobs: outbox delivery + hold-expiry sweep (T245). */
export function startJobs(deps: Deps, onError: JobErrorHandler = defaultOnError): JobHandle[] {
  return [
    schedule({ name: "outbox", everyMs: OUTBOX_POLL_MS, run: () => dispatchOutbox(deps) }, onError),
    schedule({ name: "hold-sweep", everyMs: HOLD_SWEEP_MS, run: () => expireHolds(deps) }, onError),
    schedule(
      {
        name: "retention",
        everyMs: RETENTION_INTERVAL_MS,
        firstRunMs: RETENTION_FIRST_RUN_MS,
        run: () => purgeInactive(deps.pool, deps.clock.now()),
      },
      onError,
    ),
  ];
}

export function stopJobs(handles: JobHandle[]): void {
  for (const h of handles) h.stop();
}
