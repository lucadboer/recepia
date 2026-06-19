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
}
