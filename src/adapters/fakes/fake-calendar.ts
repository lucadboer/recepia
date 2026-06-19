import type { CalendarPort, CreateEventInput, CreateEventResult } from "../../ports/calendar-port";

/**
 * In-memory CalendarPort. Idempotent on `idempotencyKey`. Failure is configurable:
 * - `failTimes`: fail the next N calls (transient), then succeed.
 * - `failAlways`: always fail (persistent outage).
 */
export class FakeCalendar implements CalendarPort {
  readonly events = new Map<string, { eventId: string; input: CreateEventInput }>();
  createdCount = 0;
  attempts = 0;
  failTimes = 0;
  failAlways = false;
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
}
