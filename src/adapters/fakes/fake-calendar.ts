import type {
  CalendarPort,
  CreateEventInput,
  CreateEventResult,
} from "../../ports/calendar-port.ts";

/**
 * In-memory CalendarPort. Idempotent on `idempotencyKey`. Failure is configurable:
 * - `failTimes`: fail the next N calls (transient), then succeed.
 * - `failAlways`: always fail (persistent outage).
 */
export class FakeCalendar implements CalendarPort {
  readonly events = new Map<string, { eventId: string; input: CreateEventInput }>();
  readonly deleted: string[] = [];
  createdCount = 0;
  attempts = 0;
  failTimes = 0;
  failAlways = false;
  /** Deletes fail independently of creates (006: a cancel whose event cannot be removed). */
  deleteFailTimes = 0;
  deleteFailAlways = false;
  private seq = 0;

  async createEvent(input: CreateEventInput): Promise<CreateEventResult> {
    this.attempts++;
    if (this.failAlways || this.failTimes > 0) {
      if (this.failTimes > 0) this.failTimes--;
      throw new Error("calendar unavailable");
    }
    const existing = this.events.get(input.idempotencyKey);
    if (existing) return { eventId: existing.eventId };
    const eventId = `evt_${++this.seq}`;
    this.events.set(input.idempotencyKey, { eventId, input });
    this.createdCount++;
    return { eventId };
  }

  async deleteEvent(idempotencyKey: string): Promise<void> {
    if (this.deleteFailAlways || this.deleteFailTimes > 0) {
      if (this.deleteFailTimes > 0) this.deleteFailTimes--;
      throw new Error("calendar unavailable (delete)");
    }
    this.deleted.push(idempotencyKey);
    if (this.events.delete(idempotencyKey)) this.createdCount--;
  }
}
