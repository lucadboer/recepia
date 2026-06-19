import { CLINIC_UTC_OFFSET_MINUTES, HORIZON_DAYS, MIN_LEAD_MS, SLOT_MINUTES } from "../config";

const OFFSET_MS = CLINIC_UTC_OFFSET_MINUTES * 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SLOT_MS = SLOT_MINUTES * 60_000;

export interface LocalParts {
  weekday: number; // 0 = Sunday
  minutesOfDay: number; // 0..1439
  dateStr: string; // YYYY-MM-DD (clinic local)
}

/** Read clinic-local wall-clock parts from a UTC instant (fixed offset, no DST). */
export function toLocalParts(instant: Date): LocalParts {
  const local = new Date(instant.getTime() + OFFSET_MS);
  const yyyy = local.getUTCFullYear();
  const mm = String(local.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(local.getUTCDate()).padStart(2, "0");
  return {
    weekday: local.getUTCDay(),
    minutesOfDay: local.getUTCHours() * 60 + local.getUTCMinutes(),
    dateStr: `${yyyy}-${mm}-${dd}`,
  };
}

/** UTC instant for a clinic-local wall time (inverse of toLocalParts). */
export function fromLocal(dateStr: string, minutesOfDay: number): Date {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
  const localWallMs = Date.UTC(y, m - 1, d) + minutesOfDay * 60_000;
  return new Date(localWallMs - OFFSET_MS);
}

/** Round an instant up to the next 30-minute grid boundary (clinic-local grid). */
export function alignUpToSlot(instant: Date): Date {
  const local = instant.getTime() + OFFSET_MS;
  const aligned = Math.ceil(local / SLOT_MS) * SLOT_MS;
  return new Date(aligned - OFFSET_MS);
}

export function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * 60_000);
}

export function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return h * 60 + m;
}

/** The bookable window for `now`: [now + min lead, now + horizon]. */
export function bookingWindow(now: Date): { from: Date; to: Date } {
  return {
    from: new Date(now.getTime() + MIN_LEAD_MS),
    to: new Date(now.getTime() + HORIZON_DAYS * DAY_MS),
  };
}
