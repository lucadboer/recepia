/** Explicit, recoverable booking errors. Never thrown silently. */

export class SlotUnavailableError extends Error {
  constructor(message = "The time is no longer available.") {
    super(message);
    this.name = "SlotUnavailableError";
  }
}

/**
 * No such booking for this patient (unknown id or another phone's booking — deliberately
 * indistinguishable to the caller, so a guessed id reveals nothing). 006.
 */
export class BookingNotFoundError extends Error {
  constructor(message = "Appointment not found.") {
    super(message);
    this.name = "BookingNotFoundError";
  }
}

/** The booking can no longer be cancelled or moved (already started, past, or not active). 006. */
export class BookingNotChangeableError extends Error {
  constructor(message = "This appointment can no longer be changed.") {
    super(message);
    this.name = "BookingNotChangeableError";
  }
}

/** A reschedule that is not a change of time of the same appointment (006 FR-605). */
export class InvalidRescheduleError extends Error {
  constructor(public readonly reason: "same_time" | "different_type") {
    super(
      reason === "same_time"
        ? "The new time is the same as the current appointment."
        : "The new time is for a different appointment type.",
    );
    this.name = "InvalidRescheduleError";
  }
}

/** The requested start is outside [now + lead, now + horizon] or off the 30-min grid. */
export class SlotOutOfWindowError extends Error {
  constructor(message = "The time is outside the booking window.") {
    super(message);
    this.name = "SlotOutOfWindowError";
  }
}

export class HoldExpiredError extends Error {
  constructor(message = "The hold expired.") {
    super(message);
    this.name = "HoldExpiredError";
  }
}

export class OutOfScopeError extends Error {
  constructor(public readonly requestedType: string) {
    super(`Not a routine appointment type: ${requestedType}`);
    this.name = "OutOfScopeError";
  }
}

export class CalendarWriteError extends Error {
  constructor(message = "Could not write the calendar event.") {
    super(message);
    this.name = "CalendarWriteError";
  }
}

export class MessagingSendError extends Error {
  constructor(message = "Could not send the message.") {
    super(message);
    this.name = "MessagingSendError";
  }
}

/** A real adapter was used without its credentials (needs-creds boundary). */
export class NotConfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotConfigured";
  }
}

/**
 * Another turn persisted this phone's conversation state first (optimistic concurrency,
 * T240). The caller must NOT retry the LLM turn: tool writes already committed are
 * idempotent, and re-running could duplicate side-effects. Phone is masked in the message.
 */
export class ConversationConflictError extends Error {
  constructor(
    public readonly phone: string,
    public readonly expectedVersion: number,
  ) {
    super(
      `Conversation state for ***${phone.slice(-4)} changed concurrently (expected version ${expectedVersion}).`,
    );
    this.name = "ConversationConflictError";
  }
}

/**
 * The worker running this turn no longer owns its inbound message: its lease expired and another
 * worker reclaimed it (008). The turn stops before any further write; the new holder runs the
 * message, and the replay guard keeps it from repeating what this turn already committed.
 */
export class LeaseLostError extends Error {
  constructor() {
    super("This turn's inbound message was taken over by another worker.");
    this.name = "LeaseLostError";
  }
}

/**
 * A message ran out of attempts and its turn left nothing to recover (008): running the turn again
 * is not allowed, so the message goes to reception.
 */
export class AttemptsExhaustedError extends Error {
  constructor() {
    super("The message's attempts are exhausted and its turn committed nothing to recover.");
    this.name = "AttemptsExhaustedError";
  }
}

/**
 * A replay could neither remove a cancelled booking's calendar event nor record a cleanup request
 * for reception (008): the message must not finish yet, so it is retried.
 */
export class CleanupPendingError extends Error {
  constructor() {
    super("A calendar cleanup could not be completed or recorded.");
    this.name = "CleanupPendingError";
  }
}

const ESCALATED_FLAG = Symbol.for("recepia.escalated");

/**
 * Mark an error as "reception was already notified before this was thrown" (confirm_booking
 * escalates internally on persistent calendar failure / orphan compensation). The tool
 * registry turns a flagged error into a hand-off instead of letting the model carry on.
 */
export function flagEscalated<E>(err: E): E {
  if (err !== null && typeof err === "object") {
    (err as unknown as Record<symbol, unknown>)[ESCALATED_FLAG] = true;
  }
  return err;
}

export function hasEscalatedFlag(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    (err as unknown as Record<symbol, unknown>)[ESCALATED_FLAG] === true
  );
}
