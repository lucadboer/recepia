import { describe, expect, it } from "vitest";
import { GoogleCalendar } from "../../src/adapters/calendar/google-calendar";

// LIVE smoke test — hits the real Google Calendar API. Out of the default
// `pnpm test` (excluded in vitest.config). Run with:
//   LIVE_CALENDAR=1 pnpm test:live
// Requires GOOGLE_CALENDAR_CREDENTIALS (path to the SA key) + GOOGLE_CALENDAR_ID
// in .env, AND the target calendar shared with the SA's client_email with the
// "Make changes to events" role. Constructed inside it() so a skipped run never
// touches credentials.
const live = process.env.LIVE_CALENDAR === "1";

describe.skipIf(!live)("GoogleCalendar — LIVE smoke test", () => {
  it("creates a real event, is idempotent on the booking id, and deletes it", async () => {
    const cal = new GoogleCalendar();
    const idempotencyKey = `recepia-live-${Date.now()}`;
    const start = new Date(Date.now() + 60 * 60 * 1000); // +1h
    const end = new Date(start.getTime() + 30 * 60 * 1000); // 30 min
    const input = {
      idempotencyKey,
      start,
      end,
      title: "Consulta de rotina (LIVE TEST recepia — pode apagar)",
      patientName: "Paciente Teste",
      patientPhone: "+550000000000",
    };

    let created = false;
    try {
      const first = await cal.createEvent(input);
      created = true;
      expect(first.eventId).toBeTruthy();

      // Re-creating with the same booking id must return the same event — no duplicate.
      const second = await cal.createEvent(input);
      expect(second.eventId).toBe(first.eventId);

      await cal.deleteEvent(idempotencyKey); // explicit cleanup — must resolve
      await cal.deleteEvent(idempotencyKey); // already gone → idempotent no-op
      created = false;
    } finally {
      if (created) await cal.deleteEvent(idempotencyKey).catch(() => {});
    }
  });
});
