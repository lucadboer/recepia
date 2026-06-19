// Structural constants for the deterministic booking slice.
// Business hours and per-day capacity live in the database (capacity_rule /
// capacity_override); these are the fixed knobs decided in spec + clarify.

export const CLINIC_TIMEZONE = "America/Sao_Paulo";

// Brazil has had no DST since 2019, so a fixed UTC offset is correct and keeps
// the slot math pure/deterministic. If DST is ever reintroduced, swap this for a
// tz-aware conversion (Intl/Temporal). Documented assumption.
export const CLINIC_UTC_OFFSET_MINUTES = -180; // UTC-03:00

export const SLOT_MINUTES = 30; // uniform routine duration + grid step (MVP)
export const HOLD_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const MIN_LEAD_MS = 2 * 60 * 60 * 1000; // 2 hours minimum lead time
export const HORIZON_DAYS = 30; // book at most 30 days ahead

// confirm_booking calendar-write retry policy (short backoff).
export const CALENDAR_MAX_ATTEMPTS = 3;
export const CALENDAR_RETRY_BASE_MS = 25;

// Safety cap on the LLM tool-use loop. TODO(product): tune final value (NEEDS-USER).
export const AGENT_MAX_ITERATIONS = 8;

export const ROUTINE_TYPES = ["evaluation", "cleaning", "follow_up", "consultation"] as const;
export type AppointmentType = (typeof ROUTINE_TYPES)[number];

export function isRoutineType(value: string): value is AppointmentType {
  return (ROUTINE_TYPES as readonly string[]).includes(value);
}
