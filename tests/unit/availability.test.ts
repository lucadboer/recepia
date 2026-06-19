import { describe, expect, it } from "vitest";
import type { CapacityOverrideRow, CapacityRuleRow } from "../../src/db/repositories/capacity-repo";
import { enumerateBusinessSlots } from "../../src/domain/availability";

const rules: CapacityRuleRow[] = [
  { weekday: 1, startTime: "09:00", endTime: "10:00", capacity: 2 }, // Monday 09:00–10:00
];

describe("enumerateBusinessSlots", () => {
  it("emits only grid slots that fit entirely inside the window", () => {
    const slots = enumerateBusinessSlots(
      new Date("2026-06-15T12:00:00Z"), // Mon 09:00 local
      new Date("2026-06-15T13:30:00Z"), // Mon 10:30 local
      rules,
      [],
    );
    expect(slots.map((s) => s.toISOString())).toEqual([
      "2026-06-15T12:00:00.000Z", // 09:00 (ends 09:30 ✓)
      "2026-06-15T12:30:00.000Z", // 09:30 (ends 10:00 ✓); 10:00 would end 10:30 > window
    ]);
  });

  it("includes override windows on a day with no rule", () => {
    const overrides: CapacityOverrideRow[] = [
      { date: "2026-06-20", startTime: "09:00", endTime: "10:00", capacity: 1 }, // Saturday
    ];
    const slots = enumerateBusinessSlots(
      new Date("2026-06-20T12:00:00Z"), // Sat 09:00 local
      new Date("2026-06-20T13:00:00Z"), // Sat 10:00 local
      rules,
      overrides,
    );
    expect(slots).toHaveLength(2); // 09:00 and 09:30 from the override
  });
});
