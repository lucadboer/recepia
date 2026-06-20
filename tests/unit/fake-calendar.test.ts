import { describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";

describe("FakeCalendar (CalendarPort contract)", () => {
  it("is idempotent on idempotencyKey: same key -> one event, same id", async () => {
    const cal = new FakeCalendar();
    const input = {
      idempotencyKey: "booking-1",
      start: new Date("2026-06-15T14:00:00Z"),
      end: new Date("2026-06-15T14:30:00Z"),
      title: "Consulta de rotina (cleaning)",
      patientName: "Paciente",
      patientPhone: "+55a",
    };

    const first = await cal.createEvent(input);
    const second = await cal.createEvent(input);

    expect(second.eventId).toBe(first.eventId); // same event id
    expect(cal.createdCount).toBe(1); // no duplicate event
    expect(cal.events.size).toBe(1);
  });

  it("deleteEvent removes the event for that idempotencyKey", async () => {
    const cal = new FakeCalendar();
    const input = {
      idempotencyKey: "booking-2",
      start: new Date("2026-06-15T15:00:00Z"),
      end: new Date("2026-06-15T15:30:00Z"),
      title: "t",
      patientName: "P",
      patientPhone: "+55b",
    };
    await cal.createEvent(input);
    await cal.deleteEvent("booking-2");

    expect(cal.events.has("booking-2")).toBe(false);
    expect(cal.deleted).toContain("booking-2");
  });
});
