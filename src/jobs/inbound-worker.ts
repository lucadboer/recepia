// 008 durable inbound pipeline: the in-process worker between the queue and the orchestrator.
// `concurrency` slots each loop claim → run → finish; a heartbeat keeps the lease alive while a
// turn runs; failures retry with jittered backoff and the last one dead-letters to reception.

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { InboundMessage } from "../agent/types.ts";
import {
  INBOUND_BACKOFF_MS,
  INBOUND_CONCURRENCY,
  INBOUND_LEASE_MS,
  INBOUND_MAX_ATTEMPTS,
  INBOUND_POLL_MS,
} from "../config.ts";
import type { Pool } from "../db/pool.ts";
import {
  claimNext,
  heartbeat,
  type InboundRow,
  markDead,
  markDone,
  markRetry,
} from "../db/repositories/inbound-repo.ts";
import type { Clock } from "../ports/clock.ts";
import { log } from "../telemetry/logger.ts";
import { messageRef } from "../telemetry/pseudonym.ts";
import { ATTR, errorTypeOf, SPAN, withRemoteParent } from "../telemetry/tracing.ts";

/** Delay before retry `attempt` (1-based): the backoff step × uniform(0.8, 1.2), capped. */
export function inboundBackoff(attempt: number, random: () => number = Math.random): number {
  const idx = Math.min(Math.max(attempt - 1, 0), INBOUND_BACKOFF_MS.length - 1);
  return Math.round(INBOUND_BACKOFF_MS[idx] * (0.8 + 0.4 * random()));
}

export interface InboundWorkerOptions {
  pool: Pool;
  clock: Clock;
  /** The orchestrator turn (`handleInbound`). A throw means "retry this message". */
  handler: (msg: InboundMessage) => Promise<unknown>;
  receptionPhone: string;
  concurrency?: number;
  leaseMs?: number;
  maxAttempts?: number;
  /** Idle re-check interval; `wake()` short-circuits it when a message was just stored. */
  pollMs?: number;
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

export function createInboundWorker(opts: InboundWorkerOptions): InboundWorker {
  const concurrency = opts.concurrency ?? INBOUND_CONCURRENCY;
  const leaseMs = opts.leaseMs ?? INBOUND_LEASE_MS;
  const maxAttempts = opts.maxAttempts ?? INBOUND_MAX_ATTEMPTS;
  const pollMs = opts.pollMs ?? INBOUND_POLL_MS;
  const workerId = opts.workerId ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

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

  async function finish(row: InboundRow, err: unknown): Promise<void> {
    const now = opts.clock.now();
    if (err === null) {
      await markDone(opts.pool, row.id, workerId, now);
      return;
    }
    const type = errorTypeOf(err);
    const ref = messageRef(row.providerMessageId);
    if (row.attempts >= maxAttempts) {
      await markDead(opts.pool, row.id, workerId, now, type, opts.receptionPhone);
      log.error(
        { event: "inbound.dead_letter", messageRef: ref, attempts: row.attempts, errorType: type },
        "inbound message dead-lettered to reception",
      );
      return;
    }
    const nextAt = new Date(now.getTime() + inboundBackoff(row.attempts));
    await markRetry(opts.pool, row.id, workerId, nextAt, type);
    log.info(
      { event: "inbound.retry", messageRef: ref, attempts: row.attempts, errorType: type },
      "inbound retry scheduled",
    );
  }

  async function run(row: InboundRow): Promise<void> {
    const beat = setInterval(
      () => {
        heartbeat(opts.pool, row.id, workerId, opts.clock.now(), leaseMs).catch(() => {});
      },
      Math.max(1_000, Math.floor(leaseMs / 3)),
    );
    beat.unref?.();
    let failure: unknown = null;
    try {
      // The turn continues the trace of the webhook request that stored the message (FR-808).
      await withRemoteParent(
        row.traceContext,
        SPAN.inboundProcess,
        {
          [ATTR.messageRef]: messageRef(row.providerMessageId),
          [ATTR.inboundAttempt]: row.attempts,
        },
        async () => {
          try {
            return await opts.handler({
              phone: row.phone,
              text: row.text,
              providerMessageId: row.providerMessageId,
              receivedAt: row.receivedAt,
            });
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
    } catch (err) {
      failure = err;
    } finally {
      clearInterval(beat);
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
        await idle();
        continue;
      }
      inFlight++;
      try {
        await run(row);
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
