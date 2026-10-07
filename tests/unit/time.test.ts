import { describe, expect, it } from "vitest";
import {
  alignUpToSlot,
  bookingWindow,
  formatLocalPt,
  formatOffset,
  fromLocal,
  timeToMinutes,
  toLocalParts,
  utcOffsetMinutes,
} from "../../src/domain/time";

describe("time — clinic-local conversion (America/Sao_Paulo via Intl)", () => {
  it("maps a UTC instant to clinic-local weekday/minutes/date", () => {
    const parts = toLocalParts(new Date("2026-06-15T12:00:00Z")); // Monday 09:00 local
    expect(parts.weekday).toBe(1);
    expect(parts.minutesOfDay).toBe(9 * 60);
    expect(parts.dateStr).toBe("2026-06-15");
  });

  it("keeps the local date when UTC has rolled past midnight", () => {
    const parts = toLocalParts(new Date("2026-06-16T02:00:00Z")); // 23:00 local on 2026-06-15
    expect(parts.dateStr).toBe("2026-06-15");
    expect(parts.minutesOfDay).toBe(23 * 60);
    expect(parts.weekday).toBe(1);
  });

  it("fromLocal is the inverse of toLocalParts", () => {
    expect(fromLocal("2026-06-15", 9 * 60).toISOString()).toBe("2026-06-15T12:00:00.000Z");
  });

  it("rounds up to the next 30-min grid boundary", () => {
    expect(alignUpToSlot(new Date("2026-06-15T12:10:00Z")).toISOString()).toBe(
      "2026-06-15T12:30:00.000Z",
    );
    expect(alignUpToSlot(new Date("2026-06-15T12:30:00Z")).toISOString()).toBe(
      "2026-06-15T12:30:00.000Z",
    );
  });

  it("parses HH:MM to minutes", () => {
    expect(timeToMinutes("09:00")).toBe(540);
    expect(timeToMinutes("18:30")).toBe(1110);
  });

  it("bookingWindow returns [now+2h, now+30d]", () => {
    const { from, to } = bookingWindow(new Date("2026-06-15T12:00:00Z"));
    expect(from.toISOString()).toBe("2026-06-15T14:00:00.000Z");
    expect(to.toISOString()).toBe("2026-07-15T12:00:00.000Z");
  });
});

describe("time — genuinely timezone-aware (IANA, DST-safe) — FR-213", () => {
  const NY = "America/New_York";

  it("reports the clinic offset as -180 min / '-03:00' (no DST in Brazil since 2019)", () => {
    expect(utcOffsetMinutes(new Date("2026-06-15T12:00:00Z"))).toBe(-180);
    expect(utcOffsetMinutes(new Date("2026-01-15T12:00:00Z"))).toBe(-180);
    expect(formatOffset(new Date("2026-06-15T12:00:00Z"))).toBe("-03:00");
  });

  it("follows DST in a zone that has it (proves no fixed offset is baked in)", () => {
    expect(utcOffsetMinutes(new Date("2026-01-15T12:00:00Z"), NY)).toBe(-300); // EST
    expect(utcOffsetMinutes(new Date("2026-07-15T12:00:00Z"), NY)).toBe(-240); // EDT
    expect(formatOffset(new Date("2026-07-15T12:00:00Z"), NY)).toBe("-04:00");
  });

  it("reads wall-clock parts correctly right after a spring-forward gap", () => {
    // 2026-03-08 07:30Z = 03:30 EDT (02:30 never existed in New York that day).
    const parts = toLocalParts(new Date("2026-03-08T07:30:00Z"), NY);
    expect(parts.dateStr).toBe("2026-03-08");
    expect(parts.minutesOfDay).toBe(3 * 60 + 30);
    expect(parts.weekday).toBe(0);
  });

  it("fromLocal shifts a non-existent wall time forward and picks the earlier instant when ambiguous", () => {
    // Gap: 02:30 does not exist on 2026-03-08 in New York → 03:30 EDT = 07:30Z.
    expect(fromLocal("2026-03-08", 2 * 60 + 30, NY).toISOString()).toBe("2026-03-08T07:30:00.000Z");
    // Overlap: 01:30 happens twice on 2026-11-01 → the first (EDT) occurrence = 05:30Z.
    expect(fromLocal("2026-11-01", 90, NY).toISOString()).toBe("2026-11-01T05:30:00.000Z");
    // Plain inverse in a zone with DST.
    expect(fromLocal("2026-07-15", 9 * 60, NY).toISOString()).toBe("2026-07-15T13:00:00.000Z");
  });

  it("honours São Paulo's historical DST (2018: UTC-2 in summer, UTC-3 in winter)", () => {
    expect(toLocalParts(new Date("2018-12-15T12:00:00Z")).minutesOfDay).toBe(10 * 60); // BRST
    expect(toLocalParts(new Date("2018-06-15T12:00:00Z")).minutesOfDay).toBe(9 * 60); // BRT
  });

  it("formatLocalPt renders DD/MM/YYYY + HH:MM in the zone (midnight rollover safe)", () => {
    expect(formatLocalPt(new Date("2026-06-16T02:00:00Z"))).toEqual({
      date: "15/06/2026",
      time: "23:00",
    });
    expect(formatLocalPt(new Date("2026-07-15T13:00:00Z"), NY)).toEqual({
      date: "15/07/2026",
      time: "09:00",
    });
  });

  it("aligns to the 30-min grid in LOCAL wall time for any zone", () => {
    // 13:10Z = 09:10 EDT → next grid boundary 09:30 EDT = 13:30Z.
    expect(alignUpToSlot(new Date("2026-07-01T13:10:00Z"), NY).toISOString()).toBe(
      "2026-07-01T13:30:00.000Z",
    );
  });
});

describe("time — clinic-local strings for the model (002 FR-213, found by the 004 live baseline)", async () => {
  const { slotLabelPt, toLocalIso } = await import("../../src/domain/time");
  it("toLocalIso renders the instant in the clinic zone with its offset (same instant)", () => {
    const at = new Date("2026-06-15T14:00:00Z");
    expect(toLocalIso(at)).toBe("2026-06-15T11:00:00-03:00");
    expect(new Date(toLocalIso(at)).getTime()).toBe(at.getTime());
    expect(toLocalIso(new Date("2026-06-16T02:30:15Z"))).toBe("2026-06-15T23:30:15-03:00"); // midnight rollover
    expect(toLocalIso(new Date("2026-07-15T13:00:00Z"), "America/New_York")).toBe(
      "2026-07-15T09:00:00-04:00",
    ); // DST
    expect(toLocalIso(new Date("2026-01-15T14:00:00Z"), "America/New_York")).toBe(
      "2026-01-15T09:00:00-05:00",
    );
  });

  it("slotLabelPt is the short pt-BR label the patient reads", () => {
    expect(slotLabelPt(new Date("2026-06-15T14:00:00Z"))).toBe("seg., 15/06 às 11:00");
    expect(slotLabelPt(new Date("2026-06-18T15:30:00Z"))).toBe("qui., 18/06 às 12:30");
  });
});
