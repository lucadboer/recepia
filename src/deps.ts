import type { Pool, PoolClient } from "./db/pool";
import type { CalendarPort } from "./ports/calendar-port";
import type { Clock } from "./ports/clock";
import type { MessagingPort } from "./ports/messaging-port";

/** Dependencies injected into every deterministic tool (no globals). */
export interface Deps {
  pool: Pool;
  clock: Clock;
  calendar: CalendarPort;
  messaging: MessagingPort;
  /** Where escalations are delivered. */
  receptionPhone: string;
  /**
   * Version id of the system prompt in effect for the current model turn (FR-409). Set by the
   * orchestrator for the duration of a turn; tools copy it into the audit payload of every
   * write the model initiated. Absent for deterministic paths (triage, jobs, CLI).
   */
  promptVersion?: string;
  /**
   * Provider id of the patient message whose turn is running (008). Stamped on every final write's
   * audit payload so a re-run of the same message (at-least-once delivery after a crash) can tell
   * the turn already committed and must not run again.
   */
  inboundMessageId?: string;
  /** The worker's claim on that message (008). Absent outside the durable queue (tests, evals). */
  lease?: TurnLease;
}

/**
 * Ownership of the inbound message whose turn is running (008). A worker can lose it — its lease
 * expired and another worker reclaimed the message — and from then on this turn must not write.
 */
export interface TurnLease {
  /** Aborted, with a LeaseLostError, once a heartbeat finds the message taken over. */
  readonly signal: AbortSignal;
  /**
   * Throws LeaseLostError unless this turn still owns its message. Inside a write transaction it
   * also locks the message row until that transaction ends, so a takeover waits for the write to
   * commit — and then the replay guard sees it.
   */
  fence(q: Pool | PoolClient): Promise<void>;
}

/** Audit-payload fields that tie a write to its turn: prompt version and inbound message (008). */
export function turnStamp(
  deps: Pick<Deps, "promptVersion" | "inboundMessageId">,
  { prompt = true }: { prompt?: boolean } = {},
): { promptVersion?: string; inboundMessageId?: string } {
  return {
    ...(prompt && deps.promptVersion ? { promptVersion: deps.promptVersion } : {}),
    ...(deps.inboundMessageId ? { inboundMessageId: deps.inboundMessageId } : {}),
  };
}

/**
 * The turn stamp for a write inside `client`'s transaction, once the turn is known to still own
 * its message (fenced on the lease, 008): a turn that lost it fails here and its write rolls back.
 */
export async function fencedStamp(
  client: PoolClient,
  deps: Pick<Deps, "promptVersion" | "inboundMessageId" | "lease">,
  opts: { prompt?: boolean } = {},
): Promise<{ promptVersion?: string; inboundMessageId?: string }> {
  await deps.lease?.fence(client);
  return turnStamp(deps, opts);
}
