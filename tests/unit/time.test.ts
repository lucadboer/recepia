import { describe, expect, it } from "vitest";
import {
  alignUpToSlot,
  bookingWindow,
  fromLocal,
  timeToMinutes,
  toLocalParts,
} from "../../src/domain/time";

describe("time — clinic-local conversion (UTC-3, no DST)", () => {
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
