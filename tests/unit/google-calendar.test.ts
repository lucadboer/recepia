import { describe, expect, it } from "vitest";
import { GoogleCalendar } from "../../src/adapters/calendar/google-calendar";
import { CALENDAR_REQUEST_TIMEOUT_MS } from "../../src/config";

// 008 review: a Calendar request that never returns must not stall a turn's compensation or the
// hold sweep — every request carries a timeout (the client is lazy: no network or file read here).

describe("GoogleCalendar", () => {
  it("bounds every Calendar request with a timeout", () => {
    const adapter = new GoogleCalendar("/nonexistent/key.json", "calendar-id");
    const client = (
      adapter as unknown as { calendar: { context: { _options: { timeout?: number } } } }
    ).calendar;
    expect(client.context._options.timeout).toBe(CALENDAR_REQUEST_TIMEOUT_MS);
  });
});
