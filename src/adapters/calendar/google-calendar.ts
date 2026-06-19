import { NotConfigured } from "../../domain/errors";
import type { CalendarPort, CreateEventInput, CreateEventResult } from "../../ports/calendar-port";

/**
 * Google Calendar adapter — SCAFFOLD. NEEDS-USER: GOOGLE_CALENDAR_CREDENTIALS
 * (OAuth/service-account JSON) + GOOGLE_CALENDAR_ID. Idempotency uses the booking id
 * (input.idempotencyKey) so retries never duplicate an event.
 */
export class GoogleCalendar implements CalendarPort {
  constructor(
    credentials = process.env.GOOGLE_CALENDAR_CREDENTIALS,
    calendarId = process.env.GOOGLE_CALENDAR_ID,
  ) {
    if (!credentials || !calendarId) {
      throw new NotConfigured(
        "GoogleCalendar: GOOGLE_CALENDAR_CREDENTIALS/ID not set (NEEDS-USER)",
      );
    }
  }

  async createEvent(_input: CreateEventInput): Promise<CreateEventResult> {
    // NEEDS-CREDS BOUNDARY — events.insert; carry idempotencyKey as a private extended
    // property (or a deterministic event id) so a retry returns the same event.
    throw new NotConfigured("GoogleCalendar: live call not wired (NEEDS-USER)");
  }

  async deleteEvent(_idempotencyKey: string): Promise<void> {
    // NEEDS-CREDS BOUNDARY — events.delete for the event mapped to idempotencyKey.
    throw new NotConfigured("GoogleCalendar: live call not wired (NEEDS-USER)");
  }
}
