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
/**
 * Every Google Calendar request gives up after this long (008 review): a call that never returns
 * must not stall a turn, its compensation or the hold sweep.
 */
export const CALENDAR_REQUEST_TIMEOUT_MS = 15_000;

// Safety cap on the LLM tool-use loop (final, T225): one booking needs 3 tool calls; 8 leaves
// room for one alternative slot plus recovery. The cost bound is DEFAULT_AGENT_BUDGET_USD below.
export const AGENT_MAX_ITERATIONS = 8;
// Per-conversation estimated-cost budget (005 FR-510, decided 2026-10-07): ≈ 8× a full booking
// conversation (~US$ 0.03). Reaching it hands the patient to reception. Override: AGENT_BUDGET_USD.
export const DEFAULT_AGENT_BUDGET_USD = 0.25;

// Bounds on per-phone ConversationState (T239). One inbound message produces at most
// 1 + 2*AGENT_MAX_ITERATIONS history messages, so 40 keeps >= 2 full turns of context.
export const HISTORY_MAX_MESSAGES = 40;
// get_availability hands the model at most this many (earliest) slots per call and flags
// `truncated` so it narrows the range. OFFERED_SLOTS_MAX must hold at least the last few
// responses so a slot the model just offered is never pruned before the patient picks it.
export const AVAILABILITY_MAX_SLOTS = 40;
export const OFFERED_SLOTS_MAX = 3 * AVAILABILITY_MAX_SLOTS;
export const ACTIVE_HOLDS_MAX = 10;
/**
 * Postgres `lock_timeout` on every connection (008 review): lock waits in this app last
 * milliseconds; one that lasts this long is a stuck transaction and fails instead of blocking.
 */
export const DB_LOCK_TIMEOUT_MS = 10_000;
/** Durable inbound pipeline (008). */
export const INBOUND_CONCURRENCY = 4;
export const INBOUND_LEASE_MS = 5 * 60 * 1000;
export const INBOUND_MAX_ATTEMPTS = 5;
export const INBOUND_POLL_MS = 1_000;
/**
 * Longest a turn may run before its attempt counts as failed (review: a provider call that never
 * returns must not hold a slot and renew its lease forever). Well above a normal turn's seconds.
 */
export const INBOUND_TURN_TIMEOUT_MS = 4 * 60 * 1000;
/**
 * After that bound, how long the worker lets the aborted turn settle before the message may run
 * again: effects already under way (a compensating calendar delete, bounded by
 * CALENDAR_REQUEST_TIMEOUT_MS per try) finish first, so a retry never races them.
 */
export const INBOUND_TURN_GRACE_MS = 2 * 60 * 1000;
/** Unfinished messages per phone beyond which new ones are stored as dropped (flood guard). */
export const INBOUND_PHONE_MAX_PENDING = 20;
/** Retry delays per failed attempt; each is jittered ±20 % (inboundBackoff). */
export const INBOUND_BACKOFF_MS = [2_000, 10_000, 30_000, 120_000, 600_000] as const;
/** Reminder jobs cadence (007): a reminder may leave up to this long after its 24 h mark. */
export const REMINDERS_INTERVAL_MS = 15 * 60 * 1000;
export const REMINDERS_FIRST_RUN_MS = 30 * 1000;
/** Bookings find_my_booking showed in one conversation (006); only one is ever acted on. */
export const SURFACED_BOOKINGS_MAX = 5;
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
// LGPD retention purge (005 FR-515): daily, first run shortly after start so a frequently
// restarted process still purges.
export const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const RETENTION_FIRST_RUN_MS = 60_000;

export const ROUTINE_TYPES = ["evaluation", "cleaning", "follow_up", "consultation"] as const;
export type AppointmentType = (typeof ROUTINE_TYPES)[number];

export function isRoutineType(value: string): value is AppointmentType {
  return (ROUTINE_TYPES as readonly string[]).includes(value);
}
