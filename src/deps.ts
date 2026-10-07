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
}
