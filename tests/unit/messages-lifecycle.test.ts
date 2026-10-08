import { describe, expect, it } from "vitest";
import {
  calendarCleanupNoticePt,
  cancellationMessagePt,
  lateChangeNoticePt,
  rescheduledMessagePt,
} from "../../src/messages";

// T605 (006) — patient and reception texts for cancel/reschedule: pt-BR, clinic-local time
// (America/Sao_Paulo, UTC-3 in June), never UTC.

const OLD = new Date("2026-06-18T12:00:00Z"); // 18/06/2026 09:00 local
const NEW = new Date("2026-06-19T17:00:00Z"); // 19/06/2026 14:00 local

describe("patient messages", () => {
  it("cancellation names the type and the local date/time and invites a new booking", () => {
    const m = cancellationMessagePt("cleaning", OLD);
    expect(m).toContain("limpeza");
    expect(m).toContain("18/06/2026 às 09:00");
    expect(m).toMatch(/cancelada/);
    expect(m).not.toMatch(/UTC|Z\b/);
  });

  it("reschedule shows the old and the new local time", () => {
    const m = rescheduledMessagePt("evaluation", OLD, NEW);
    expect(m).toContain("avaliação");
    expect(m).toContain("18/06/2026 às 09:00");
    expect(m).toContain("19/06/2026 às 14:00");
    expect(m).toMatch(/remarcada/);
  });
});

describe("reception notices", () => {
  it("a late cancel tells reception who, which time was freed and why it is flagged", () => {
    const m = lateChangeNoticePt({
      change: "cancelled",
      phone: "+5531900000601",
      name: "Ana Teste",
      type: "cleaning",
      start: OLD,
    });
    expect(m).toMatch(/menos de 24h/);
    expect(m).toContain("Ana Teste");
    expect(m).toContain("+5531900000601"); // reception calls the patient back
    expect(m).toContain("18/06/2026 às 09:00");
    expect(m).toMatch(/cancelad/);
  });

  it("a late reschedule also names the new time", () => {
    const m = lateChangeNoticePt({
      change: "rescheduled",
      phone: "+5531900000601",
      name: null,
      type: "cleaning",
      start: OLD,
      newStart: NEW,
    });
    expect(m).toContain("19/06/2026 às 14:00");
    expect(m).toMatch(/remarcad/);
    expect(m).not.toContain("null");
  });

  it("a calendar cleanup notice asks reception to delete the event by hand", () => {
    const m = calendarCleanupNoticePt({ phone: "+5531900000601", start: OLD });
    expect(m).toContain("18/06/2026 às 09:00");
    expect(m).toMatch(/agenda/);
    expect(m).toMatch(/manualmente/);
  });
});
