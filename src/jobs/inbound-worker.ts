// 008 durable inbound pipeline: the in-process worker between the queue and the orchestrator.
// `concurrency` slots each loop claim → run → finish; a heartbeat keeps the lease alive while a
// turn runs; failures retry with jittered backoff and the last one dead-letters to reception.
// Every claim carries its own lease token: a turn that lost its message to another worker is
// signalled to stop, its writes are fenced on that token, and it finishes nothing.

import { hostname } from "node:os";
import type { InboundMessage, TurnOptions } from "../agent/types";
import {
  INBOUND_BACKOFF_MS,
  INBOUND_CONCURRENCY,
  INBOUND_LEASE_MS,
  INBOUND_MAX_ATTEMPTS,
  INBOUND_POLL_MS,
  INBOUND_TURN_GRACE_MS,
  INBOUND_TURN_TIMEOUT_MS,
} from "../config";
import type { Pool } from "../db/pool";
import {
  claimNext,
  heartbeat,
  type InboundRow,
  leaseHeld,
  markDead,
  markDone,
  markRetry,
} from "../db/repositories/inbound-repo";
import type { TurnLease } from "../deps";
import { LeaseLostError } from "../domain/errors";
import type { Clock } from "../ports/clock";
import { log } from "../telemetry/logger";
import { messageRef } from "../telemetry/pseudonym";
import { ATTR, errorTypeOf, SPAN, withRemoteParent } from "../telemetry/tracing";

/** Delay before retry `attempt` (1-based): the backoff step × uniform(0.8, 1.2), capped. */
export function inboundBackoff(attempt: number, random: () => number = Math.random): number {
  const idx = Math.min(Math.max(attempt - 1, 0), INBOUND_BACKOFF_MS.length - 1);
  return Math.round(INBOUND_BACKOFF_MS[idx] * (0.8 + 0.4 * random()));
}

export interface InboundWorkerOptions {
  pool: Pool;
  clock: Clock;
  /**
   * The orchestrator turn (`handleInbound`, given the lease as `deps.lease`). A throw means "retry
   * this message"; a LeaseLostError means another worker owns it now. `opts.recoverOnly` asks only
   * for the recovery of an earlier attempt (attempts exhausted).
   */
  handler: (msg: InboundMessage, lease: TurnLease, opts: TurnOptions) => Promise<unknown>;
  receptionPhone: string;
  concurrency?: number;
  leaseMs?: number;
  maxAttempts?: number;
  /** Idle re-check interval; `wake()` short-circuits it when a message was just stored. */
  pollMs?: number;
  /** A turn still running after this long is a failed attempt (see INBOUND_TURN_TIMEOUT_MS). */
  turnTimeoutMs?: number;
  /** How long a timed-out turn may still settle before its message may run again. */
  turnGraceMs?: number;
  workerId?: string;
}

export interface InboundWorker {
  start(): void;
  /** A message was just stored: let an idle slot claim it now. */
  wake(): void;
  /** Stop claiming and wait (bounded) for the turns in flight. True when all finished in time. */
  drain(timeoutMs: number): Promise<boolean>;
  readonly inFlight: number;
}

/** A turn ran past its bound; its attempt failed and its lease token is void. */
export class InboundTurnTimeoutError extends Error {
  constructor(ms: number) {
    super(`The turn did not finish within ${ms} ms.`);
    this.name = "InboundTurnTimeoutError";
  }
}

/** True when `p` settles (either way) within `ms`. */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([
      p.then(
        () => true as const,
        () => true as const,
      ),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The lease of one claim, handed to its turn. `lose()` is called when a heartbeat finds it gone. */
export function createTurnLease(
  pool: Pool,
  row: Pick<InboundRow, "id" | "lease">,
): TurnLease & { lose(): void } {
  const controller = new AbortController();
  const lose = () => {
    if (!controller.signal.aborted) controller.abort(new LeaseLostError());
  };
  return {
    signal: controller.signal,
    lose,
    async fence(tx) {
      controller.signal.throwIfAborted();
      if (await leaseHeld(tx ?? pool, row.id, row.lease)) return;
      lose();
      controller.signal.throwIfAborted();
    },
  };
}

export function createInboundWorker(opts: InboundWorkerOptions): InboundWorker {
  const concurrency = opts.concurrency ?? INBOUND_CONCURRENCY;
  const leaseMs = opts.leaseMs ?? INBOUND_LEASE_MS;
  const maxAttempts = opts.maxAttempts ?? INBOUND_MAX_ATTEMPTS;
  const pollMs = opts.pollMs ?? INBOUND_POLL_MS;
  const turnTimeoutMs = opts.turnTimeoutMs ?? INBOUND_TURN_TIMEOUT_MS;
  const turnGraceMs = opts.turnGraceMs ?? INBOUND_TURN_GRACE_MS;
  const workerId = opts.workerId ?? `${hostname()}:${process.pid}`; // + a uuid per claim

  let stopping = false;
  let inFlight = 0;
  let slots: Promise<void>[] = [];
  const waiters = new Set<() => void>();

  const wake = () => {
    for (const w of waiters) w();
    waiters.clear();
  };

  const idle = () =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(t);
        waiters.delete(done);
        resolve();
      };
      const t = setTimeout(done, pollMs);
      t.unref?.();
      waiters.add(done);
    });

  const leaseLost = (row: InboundRow) =>
    log.warn(
      {
        event: "inbound.lease_lost",
        messageRef: messageRef(row.providerMessageId),
        attempts: row.attempts,
      },
      "inbound message taken over by another worker; this attempt finishes nothing",
    );

  async function finish(row: InboundRow, err: unknown): Promise<void> {
    const now = opts.clock.now();
    if (err === null) {
      if (!(await markDone(opts.pool, row.id, row.lease, now))) leaseLost(row);
      return;
    }
    const type = errorTypeOf(err);
    const ref = messageRef(row.providerMessageId);
    // The last turn attempt failed: one recovery pass follows (recoverOnly, no new turn) so work
    // that attempt committed is finished instead of reported as a failure (review); only a
    // failed recovery pass goes to reception.
    if (row.attempts > maxAttempts) {
      if (!(await markDead(opts.pool, row.id, row.lease, now, type, opts.receptionPhone))) {
        leaseLost(row);
        return;
      }
      log.error(
        { event: "inbound.dead_letter", messageRef: ref, attempts: row.attempts, errorType: type },
        "inbound message dead-lettered to reception",
      );
      return;
    }
    const nextAt = new Date(
      now.getTime() + (row.attempts >= maxAttempts ? 0 : inboundBackoff(row.attempts)),
    );
    if (!(await markRetry(opts.pool, row.id, row.lease, nextAt, type))) {
      leaseLost(row);
      return;
    }
    log.info(
      { event: "inbound.retry", messageRef: ref, attempts: row.attempts, errorType: type },
      "inbound retry scheduled",
    );
  }

  async function run(row: InboundRow, turnOpts: TurnOptions = {}): Promise<void> {
    const lease = createTurnLease(opts.pool, row);
    const beat = setInterval(
      () => {
        heartbeat(opts.pool, row.id, row.lease, opts.clock.now(), leaseMs)
          .then((held) => {
            if (!held) lease.lose(); // taken over: the turn stops at its next check
          })
          .catch(() => {}); // a failed heartbeat is not a lost lease; the fence decides
      },
      Math.max(1_000, Math.floor(leaseMs / 3)),
    );
    beat.unref?.();
    let failure: unknown = null;
    // The turn continues the trace of the webhook request that stored the message (FR-808).
    const turn = withRemoteParent(
      row.traceContext,
      SPAN.inboundProcess,
      {
        [ATTR.messageRef]: messageRef(row.providerMessageId),
        [ATTR.inboundAttempt]: row.attempts,
      },
      async () => {
        try {
          return await opts.handler(
            {
              phone: row.phone,
              text: row.text,
              providerMessageId: row.providerMessageId,
              receivedAt: row.receivedAt,
              inboundMessageId: row.id,
            },
            lease,
            turnOpts,
          );
        } catch (err) {
          // Logged inside the span so the line carries the message's trace id (masked by the
          // logger's PII backstop); the span records the error type only.
          log.warn(
            {
              event: "inbound.turn_failed",
              messageRef: messageRef(row.providerMessageId),
              attempts: row.attempts,
              err,
            },
            "inbound turn failed",
          );
          throw err;
        }
      },
    );
    // A turn that outlives its bound settles unobserved: its lease token is void by then (review).
    turn.catch(() => {});
    let timedOut = false;
    let bound: NodeJS.Timeout | undefined;
    const outlived = new Promise<never>((_, reject) => {
      bound = setTimeout(() => {
        timedOut = true;
        reject(new InboundTurnTimeoutError(turnTimeoutMs));
      }, turnTimeoutMs);
    });
    try {
      await Promise.race([turn, outlived]);
    } catch (err) {
      failure = err;
    } finally {
      clearInterval(beat);
      clearTimeout(bound);
    }
    if (timedOut) {
      // Tell the stalled turn to stop; its writes are fenced from here on. Effects it already
      // started (a compensating calendar delete, say) cannot be cancelled, so they settle first
      // — bounded — before the attempt fails and another may reuse what they touch (review).
      lease.lose();
      log.warn(
        {
          event: "inbound.turn_timeout",
          messageRef: messageRef(row.providerMessageId),
          attempts: row.attempts,
        },
        "inbound turn exceeded its time bound",
      );
      if (!(await settlesWithin(turn, turnGraceMs))) {
        log.error(
          { event: "inbound.turn_stuck", messageRef: messageRef(row.providerMessageId) },
          "a timed-out inbound turn did not settle within its grace period",
        );
      }
      await finish(row, failure);
      return;
    }
    if (failure instanceof LeaseLostError || lease.signal.aborted) {
      leaseLost(row); // the new holder runs (or already ran) the message
      return;
    }
    await finish(row, failure);
  }

  async function slot(): Promise<void> {
    while (!stopping) {
      let row: InboundRow | null = null;
      try {
        row = await claimNext(opts.pool, workerId, opts.clock.now(), leaseMs);
      } catch (err) {
        log.error({ event: "inbound.claim_failed", err }, "could not claim an inbound message");
      }
      if (!row) {
        // drain() may have run its wake-up while this claim was in flight (review).
        if (stopping) break;
        await idle();
        continue;
      }
      inFlight++;
      try {
        // Earlier attempts were claimed but never finished — their process died mid-turn — so the
        // claim count is past the limit, which holds across crashes too (review): only recover what
        // the last attempt committed; with nothing to recover the message goes to reception.
        await run(row, row.attempts > maxAttempts ? { recoverOnly: true } : {});
      } catch (err) {
        // finishing failed (DB down): the lease will expire and another attempt will run it.
        log.error({ event: "inbound.finish_failed", err }, "could not record an inbound outcome");
      } finally {
        inFlight--;
      }
    }
  }

  return {
    start() {
      if (slots.length > 0) return;
      stopping = false;
      slots = Array.from({ length: concurrency }, () => slot());
    },
    wake,
    async drain(timeoutMs: number): Promise<boolean> {
      stopping = true;
      wake();
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      });
      try {
        return await Promise.race([Promise.all(slots).then(() => true as const), timedOut]);
      } finally {
        clearTimeout(timer);
      }
    },
    get inFlight() {
      return inFlight;
    },
  };
}
