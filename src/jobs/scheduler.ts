import { HOLD_SWEEP_MS, OUTBOX_POLL_MS } from "../config";
import type { Deps } from "../deps";
import { dispatchOutbox } from "./dispatch-outbox";
import { expireHolds } from "./expire-holds";

export interface ScheduledJob {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
}

export interface JobHandle {
  readonly name: string;
  /** True while a run is in flight (ticks that arrive meanwhile are skipped). */
  readonly running: boolean;
  stop(): void;
}

export type JobErrorHandler = (name: string, err: unknown) => void;

const defaultOnError: JobErrorHandler = (name, err) => {
  console.error(`[jobs] ${name} failed`, err);
};

/**
 * Minimal in-process scheduler: setInterval + an in-flight guard so a slow run is never
 * overlapped by the next tick. Errors are reported and never stop the schedule. The
 * timer is unref'd so it alone does not keep the process alive.
 */
export function schedule(job: ScheduledJob, onError: JobErrorHandler = defaultOnError): JobHandle {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    Promise.resolve()
      .then(() => job.run()) // a synchronous throw becomes a rejection, never an uncaught exception
      .catch((err) => onError(job.name, err))
      .finally(() => {
        inFlight = false;
      });
  }, job.everyMs);
  timer.unref?.();
  return {
    name: job.name,
    get running() {
      return inFlight;
    },
    stop: () => clearInterval(timer),
  };
}

/** The production background jobs: outbox delivery + hold-expiry sweep (T245). */
export function startJobs(deps: Deps, onError: JobErrorHandler = defaultOnError): JobHandle[] {
  return [
    schedule({ name: "outbox", everyMs: OUTBOX_POLL_MS, run: () => dispatchOutbox(deps) }, onError),
    schedule({ name: "hold-sweep", everyMs: HOLD_SWEEP_MS, run: () => expireHolds(deps) }, onError),
  ];
}

export function stopJobs(handles: JobHandle[]): void {
  for (const h of handles) h.stop();
}
