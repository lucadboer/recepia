import type { Pool } from "./db/pool";
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
