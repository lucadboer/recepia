import { SLOT_MINUTES } from "../config";
import type { CapacityOverrideRow, CapacityRuleRow } from "../db/repositories/capacity-repo";
import { addMinutes, alignUpToSlot, timeToMinutes, toLocalParts } from "./time";

/**
 * All 30-min grid slot-starts in [from, to) that fit entirely inside a business
 * window (a rule window for the weekday, or an override window for the date).
 * Capacity is applied separately by the caller via capacityFor().
 */
export function enumerateBusinessSlots(
  from: Date,
  to: Date,
  rules: CapacityRuleRow[],
  overrides: CapacityOverrideRow[],
): Date[] {
  const slots: Date[] = [];
  let t = alignUpToSlot(from);
  while (t.getTime() < to.getTime()) {
    const { weekday, minutesOfDay, dateStr } = toLocalParts(t);
    const endMin = minutesOfDay + SLOT_MINUTES;
    const windows = [
      ...rules.filter((r) => r.weekday === weekday),
      ...overrides.filter((o) => o.date === dateStr),
    ];
    const fits = windows.some(
      (w) => timeToMinutes(w.startTime) <= minutesOfDay && endMin <= timeToMinutes(w.endTime),
    );
    if (fits) slots.push(new Date(t));
    t = addMinutes(t, SLOT_MINUTES);
  }
  return slots;
}
