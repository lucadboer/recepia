import { type calendar_v3, google } from "googleapis";
import { CALENDAR_REQUEST_TIMEOUT_MS } from "../../config";
import { CalendarWriteError, NotConfigured } from "../../domain/errors";
import type { CalendarPort, CreateEventInput, CreateEventResult } from "../../ports/calendar-port";

// Least-privilege scope: manage events on calendars the SA can access, nothing
// else. The SA must be granted "Make changes to events" on the target calendar.
// https://developers.google.com/workspace/calendar/api/auth
const SCOPES = ["https://www.googleapis.com/auth/calendar.events"];

/**
 * Real Google Calendar adapter (API v3) authenticated with a service-account JSON
 * key (GoogleAuth + keyFile — the current recommended pattern for a backend writing
 * to a shared calendar). NEEDS-USER: GOOGLE_CALENDAR_CREDENTIALS (path to the SA key)
 * + GOOGLE_CALENDAR_ID (the shared calendar's id — the primary calendar's id is the
 * owner's email). The calendar must be shared with the SA's client_email with the
 * "Make changes to events" role.
 *
 * Idempotency: the booking id (input.idempotencyKey) is mapped to a DETERMINISTIC
 * Calendar event id, so createEvent never duplicates and deleteEvent — which only
 * receives the idempotencyKey — can locate the event without external state. The
 * Calendar event-id charset is base32hex (a-v, 0-9); a raw booking id (UUID) is not
 * valid, so it is hex-encoded (hex ⊂ base32hex). events.insert is the documented
 * place to set a custom id; extendedProperties are NOT for dedup.
 * https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
 */
export class GoogleCalendar implements CalendarPort {
  private readonly calendar: calendar_v3.Calendar;
  private readonly calendarId: string;

  constructor(
    credentials = process.env.GOOGLE_CALENDAR_CREDENTIALS,
    calendarId = process.env.GOOGLE_CALENDAR_ID,
  ) {
    if (!credentials || !calendarId) {
      throw new NotConfigured(
        "GoogleCalendar: GOOGLE_CALENDAR_CREDENTIALS/ID not set (NEEDS-USER)",
      );
    }
    // GoogleAuth/keyFile are lazy — no network or file read happens here.
    const auth = new google.auth.GoogleAuth({ keyFile: credentials, scopes: SCOPES });
    // Every request is bounded (008 review): a stalled call cannot hold a turn or the hold sweep.
    this.calendar = google.calendar({ version: "v3", auth, timeout: CALENDAR_REQUEST_TIMEOUT_MS });
    this.calendarId = calendarId;
  }

  async createEvent(input: CreateEventInput): Promise<CreateEventResult> {
    const eventId = toEventId(input.idempotencyKey);
    try {
      // NEEDS-CREDS BOUNDARY — events.insert. dateTime is RFC3339 with a UTC offset
      // (toISOString → "...Z"), which satisfies the API without a timeZone field.
      // TODO(product): set a clinic-local `timeZone` (IANA) for display if desired.
      const res = await this.calendar.events.insert({
        calendarId: this.calendarId,
        requestBody: {
          id: eventId,
          summary: input.title,
          description: `Paciente: ${input.patientName}\nTelefone: ${input.patientPhone}`,
          start: { dateTime: input.start.toISOString() },
          end: { dateTime: input.end.toISOString() },
        },
      });
      return { eventId: res.data.id ?? eventId };
    } catch (err) {
      // A retry of an already-created booking collides on the deterministic id →
      // idempotent success (the event already exists with exactly this id).
      if (httpStatus(err) === 409) return { eventId };
      throw new CalendarWriteError(`GoogleCalendar.createEvent failed: ${describe(err)}`);
    }
  }

  async deleteEvent(idempotencyKey: string): Promise<void> {
    const eventId = toEventId(idempotencyKey);
    try {
      // NEEDS-CREDS BOUNDARY — events.delete by the deterministic id.
      await this.calendar.events.delete({ calendarId: this.calendarId, eventId });
    } catch (err) {
      // Best-effort compensation: already gone (404 Not Found / 410 Gone) is success.
      const status = httpStatus(err);
      if (status === 404 || status === 410) return;
      throw new CalendarWriteError(`GoogleCalendar.deleteEvent failed: ${describe(err)}`);
    }
  }
}

/**
 * Map a booking id to a valid, deterministic Calendar event id. The Calendar id
 * charset is base32hex (lowercase a-v + 0-9), length 5–1024; hex output (0-9a-f)
 * is a subset, and the "recepia:" namespace guarantees the 5-char minimum.
 */
function toEventId(idempotencyKey: string): string {
  return Buffer.from(`recepia:${idempotencyKey}`, "utf8").toString("hex");
}

/** Extract the HTTP status from a googleapis/gaxios error, however it surfaces. */
function httpStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  const raw = e.response?.status ?? e.status ?? e.code;
  const n = typeof raw === "string" ? Number(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
