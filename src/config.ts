// Structural constants for the deterministic booking slice.
// Business hours and per-day capacity live in the database (capacity_rule /
// capacity_override); these are the fixed knobs decided in spec + clarify.

// IANA zone used for every clinic-local computation and patient-facing date (FR-213).
// Resolved through Intl at runtime (DST-aware), never a fixed UTC offset.
export const CLINIC_TIMEZONE = "America/Sao_Paulo";

export const SLOT_MINUTES = 30; // uniform routine duration + grid step (MVP)
export const HOLD_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const MIN_LEAD_MS = 2 * 60 * 60 * 1000; // 2 hours minimum lead time
export const HORIZON_DAYS = 30; // book at most 30 days ahead

// confirm_booking calendar-write retry policy (short backoff).
export const CALENDAR_MAX_ATTEMPTS = 3;
export const CALENDAR_RETRY_BASE_MS = 25;

// Safety cap on the LLM tool-use loop (final, T225): one booking needs 3 tool calls; 8 leaves
// room for one alternative slot plus recovery. A cost budget per conversation comes with 005.
export const AGENT_MAX_ITERATIONS = 8;

// Bounds on per-phone ConversationState (T239). One inbound message produces at most
// 1 + 2*AGENT_MAX_ITERATIONS history messages, so 40 keeps >= 2 full turns of context.
export const HISTORY_MAX_MESSAGES = 40;
// get_availability hands the model at most this many (earliest) slots per call and flags
// `truncated` so it narrows the range. OFFERED_SLOTS_MAX must hold at least the last few
// responses so a slot the model just offered is never pruned before the patient picks it.
export const AVAILABILITY_MAX_SLOTS = 40;
export const OFFERED_SLOTS_MAX = 3 * AVAILABILITY_MAX_SLOTS;
export const ACTIVE_HOLDS_MAX = 10;
export const PROCESSED_IDS_MAX = 200;

// Handed-off conversations (FR-211, T237): the patient gets at most one "reception will
// continue" notice per interval; nothing else until reception releases the conversation.
export const HANDOFF_NOTICE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Webhook hardening (T246).
export const WEBHOOK_MAX_BODY_BYTES = 256 * 1024; // provider payloads are a few KiB
export const WEBHOOK_HEADERS_TIMEOUT_MS = 5_000;
export const WEBHOOK_REQUEST_TIMEOUT_MS = 10_000; // must exceed headersTimeout
export const SHUTDOWN_TIMEOUT_MS = 15_000; // budget to drain in-flight turns on SIGTERM

// Background jobs (T245). The orchestrator also flushes the outbox within each turn; the
// poller only catches retries and anything a crashed turn left behind.
export const OUTBOX_POLL_MS = 15_000;
export const HOLD_SWEEP_MS = 60_000;

export const ROUTINE_TYPES = ["evaluation", "cleaning", "follow_up", "consultation"] as const;
export type AppointmentType = (typeof ROUTINE_TYPES)[number];

export function isRoutineType(value: string): value is AppointmentType {
  return (ROUTINE_TYPES as readonly string[]).includes(value);
}
