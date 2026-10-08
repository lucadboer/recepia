import type { CapacityOverrideRow, CapacityRuleRow } from "../db/repositories/capacity-repo.ts";
import { timeToMinutes, toLocalParts } from "./time.ts";

/**
 * Pooled capacity for a slot: capacity(T) = override(date, window) ?? rule(weekday, window).
 * Returns 0 outside any window (closed). Override wins, including 0 (closed for the day).
 */
export function capacityFor(
  slotStart: Date,
  rules: CapacityRuleRow[],
  overrides: CapacityOverrideRow[],
): number {
  const { weekday, minutesOfDay, dateStr } = toLocalParts(slotStart);

  const override = overrides.find(
    (o) =>
      o.date === dateStr &&
      timeToMinutes(o.startTime) <= minutesOfDay &&
      minutesOfDay < timeToMinutes(o.endTime),
  );
  if (override) return override.capacity;

  const rule = rules.find(
    (r) =>
      r.weekday === weekday &&
      timeToMinutes(r.startTime) <= minutesOfDay &&
      minutesOfDay < timeToMinutes(r.endTime),
  );
  return rule ? rule.capacity : 0;
}
