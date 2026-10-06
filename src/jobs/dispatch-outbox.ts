import type { PoolClient } from "../db/pool";
import { appendAudit } from "../db/repositories/audit-repo";
import {
  claimDue,
  enqueueOutbox,
  markFailed,
  markRetry,
  markSent,
  type OutboxRow,
} from "../db/repositories/outbox-repo";
import type { Deps } from "../deps";
import { escalationMessagePt } from "../messages";

/** Delay before attempt n+1 after the n-th failure (n = 1..). The last value repeats. */
export const OUTBOX_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000];
/** The attempt whose failure dead-letters the row (~43 min of retries in total). */
export const OUTBOX_MAX_ATTEMPTS = 6;
/** Messaging adapters have no timeout of their own; bound each send here. */
export const OUTBOX_SEND_TIMEOUT_MS = 15_000;

export interface DispatchOutboxOptions {
  /** Max rows processed per call (one transaction each). Default 20. */
  batchSize?: number;
  sendTimeoutMs?: number;
}

export interface DispatchOutboxResult {
  sent: number;
  retried: number;
  failed: number;
}

type Outcome = keyof DispatchOutboxResult;

const KIND_LABEL_PT: Record<OutboxRow["kind"], string> = {
  booking_confirmation: "a confirmação da consulta",
  escalation: "o aviso à recepção",
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export function backoffFor(attempts: number): number {
  const idx = Math.min(Math.max(attempts - 1, 0), OUTBOX_BACKOFF_MS.length - 1);
  return OUTBOX_BACKOFF_MS[idx];
}

/**
 * Deliver due outbox rows. One row per transaction: claim (SKIP LOCKED) → send → mark →
 * COMMIT, so a crash mid-send rolls the claim back and the row is retried (at-least-once).
 * After OUTBOX_MAX_ATTEMPTS the row is dead-lettered: `failed` + `outbox_dead_letter` audit
 * + an escalation row for reception (a dead-lettered escalation only audits — no loop).
 */
export async function dispatchOutbox(
  deps: Deps,
  opts: DispatchOutboxOptions = {},
): Promise<DispatchOutboxResult> {
  const batchSize = opts.batchSize ?? 20;
  const timeoutMs = opts.sendTimeoutMs ?? OUTBOX_SEND_TIMEOUT_MS;
  const result: DispatchOutboxResult = { sent: 0, retried: 0, failed: 0 };
  for (let i = 0; i < batchSize; i++) {
    const outcome = await dispatchOne(deps, timeoutMs);
    if (outcome === null) break;
    result[outcome]++;
  }
  return result;
}

async function dispatchOne(deps: Deps, timeoutMs: number): Promise<Outcome | null> {
  const now = deps.clock.now();
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const row = await claimDue(client, now);
    if (!row) {
      await client.query("COMMIT");
      return null;
    }
    const attempts = row.attempts + 1;
    let outcome: Outcome;
    try {
      await withTimeout(deps.messaging.sendMessage(row.toPhone, row.body), timeoutMs);
      await markSent(client, row.id, attempts, now);
      outcome = "sent";
    } catch (sendErr) {
      const message = errorMessage(sendErr);
      if (attempts >= OUTBOX_MAX_ATTEMPTS) {
        await deadLetter(deps, client, row, attempts, message, now);
        outcome = "failed";
      } else {
        const nextAt = new Date(now.getTime() + backoffFor(attempts));
        await markRetry(client, row.id, attempts, nextAt, message);
        outcome = "retried";
      }
    }
    await client.query("COMMIT");
    return outcome;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function deadLetter(
  deps: Deps,
  client: PoolClient,
  row: OutboxRow,
  attempts: number,
  lastError: string,
  now: Date,
): Promise<void> {
  await markFailed(client, row.id, attempts, lastError);
  await appendAudit(client, {
    entity: "outbox",
    entityId: row.id,
    action: "outbox_dead_letter",
    actor: "system",
    payload: { kind: row.kind, toPhone: row.toPhone, attempts, lastError },
  });
  if (row.kind === "escalation") return; // never escalate a failed escalation (no loop)

  const context = `Não foi possível entregar ${KIND_LABEL_PT[row.kind]} após ${attempts} tentativas (${lastError}).`;
  const escalationId = await enqueueOutbox(client, {
    kind: "escalation",
    toPhone: deps.receptionPhone,
    body: escalationMessagePt({
      reason: "delivery_failed",
      phone: row.toPhone,
      context,
      summary: [],
    }),
    now,
  });
  await appendAudit(client, {
    entity: "escalation",
    entityId: null,
    action: "escalated",
    actor: "system",
    payload: {
      reason: "delivery_failed",
      context,
      phone: row.toPhone,
      summary: [],
      outboxId: escalationId,
    },
  });
}
