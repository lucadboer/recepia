export interface CreateEventInput {
  /** Idempotency key (the booking id): same key returns the same event, never a duplicate. */
  idempotencyKey: string;
  start: Date;
  end: Date;
  title: string;
  patientName: string;
  patientPhone: string;
}

export interface CreateEventResult {
  eventId: string;
}

/**
 * Writes confirmed events to the clinic calendar (Google Calendar in production).
 * The port does not retry — confirm_booking owns the retry/escalation policy.
 */
export interface CalendarPort {
  createEvent(input: CreateEventInput): Promise<CreateEventResult>;
  /** Best-effort compensation: remove an event by its idempotency key (booking id). */
  deleteEvent(idempotencyKey: string): Promise<void>;
}
