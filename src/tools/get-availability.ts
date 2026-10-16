import { isRoutineType, SLOT_MINUTES } from "../config.ts";
import { countActiveInRange } from "../db/repositories/booking-repo.ts";
import { loadOverrides, loadRules } from "../db/repositories/capacity-repo.ts";
import type { Deps } from "../deps.ts";
import { enumerateBusinessSlots } from "../domain/availability.ts";
import { capacityFor } from "../domain/capacity.ts";
import { OutOfScopeError } from "../domain/errors.ts";
import { addMinutes, bookingWindow, toLocalParts } from "../domain/time.ts";
import type { Slot } from "../domain/types.ts";

export interface Period {
  from: Date;
  to: Date;
}

/**
 * The single source of bookable times. Returns only slots with free capacity,
 * within business hours and the [now+2h, now+30d] horizon, on the 30-min grid.
 */
export async function getAvailability(deps: Deps, period: Period, type: string): Promise<Slot[]> {
  if (!isRoutineType(type)) throw new OutOfScopeError(type);

  const now = deps.clock.now();
  const win = bookingWindow(now);
  const from = new Date(Math.max(period.from.getTime(), win.from.getTime()));
  const to = new Date(Math.min(period.to.getTime(), win.to.getTime()));
  if (from.getTime() >= to.getTime()) return [];

  const rules = await loadRules(deps.pool);
  const overrides = await loadOverrides(
    deps.pool,
    toLocalParts(from).dateStr,
    toLocalParts(to).dateStr,
  );

  const candidates = enumerateBusinessSlots(from, to, rules, overrides);
  const used = await countActiveInRange(deps.pool, from, to, now);

  const result: Slot[] = [];
  for (const start of candidates) {
    const capacity = capacityFor(start, rules, overrides);
    const taken = used.get(start.getTime()) ?? 0;
    if (capacity - taken > 0) {
      result.push({ start, end: addMinutes(start, SLOT_MINUTES), type });
    }
  }
  return result;
}
