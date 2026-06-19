import { describe, expect, it } from "vitest";
import { capacityFor } from "../../src/domain/capacity";
import type { CapacityOverrideRow, CapacityRuleRow } from "../../src/db/repositories/capacity-repo";

const rules: CapacityRuleRow[] = [
  { weekday: 1, startTime: "09:00", endTime: "18:00", capacity: 2 },
];

describe("capacity resolution (override ?? rule)", () => {
  it("uses the rule capacity within business hours", () => {
    expect(capacityFor(new Date("2026-06-15T12:00:00Z"), rules, [])).toBe(2); // Mon 09:00
  });

  it("is 0 before business hours", () => {
    expect(capacityFor(new Date("2026-06-15T11:00:00Z"), rules, [])).toBe(0); // Mon 08:00
  });

  it("is 0 on a day with no rule", () => {
    expect(capacityFor(new Date("2026-06-20T12:00:00Z"), rules, [])).toBe(0); // Saturday
  });

  it("lets an override take precedence within its window", () => {
    const overrides: CapacityOverrideRow[] = [
      { date: "2026-06-15", startTime: "09:00", endTime: "12:00", capacity: 1 },
    ];
    expect(capacityFor(new Date("2026-06-15T12:00:00Z"), rules, overrides)).toBe(1);
  });

  it("treats an override capacity of 0 as closed", () => {
    const overrides: CapacityOverrideRow[] = [
      { date: "2026-06-15", startTime: "09:00", endTime: "18:00", capacity: 0 },
    ];
    expect(capacityFor(new Date("2026-06-15T12:00:00Z"), rules, overrides)).toBe(0);
  });

  it("falls back to the rule outside the override window", () => {
    const overrides: CapacityOverrideRow[] = [
      { date: "2026-06-15", startTime: "09:00", endTime: "10:00", capacity: 5 },
    ];
    expect(capacityFor(new Date("2026-06-15T16:00:00Z"), rules, overrides)).toBe(2); // 13:00 local
  });
});
