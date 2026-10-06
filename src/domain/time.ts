import { CLINIC_TIMEZONE, HORIZON_DAYS, MIN_LEAD_MS, SLOT_MINUTES } from "../config";

const DAY_MS = 24 * 60 * 60 * 1000;
const SLOT_MS = SLOT_MINUTES * 60_000;
const MINUTE_MS = 60_000;

export interface LocalParts {
  weekday: number; // 0 = Sunday
  minutesOfDay: number; // 0..1439
  dateStr: string; // YYYY-MM-DD (clinic local)
}

// One formatter per IANA zone (construction is the expensive part of Intl).
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface WallClock {
  year: number;
  month: number; // 1..12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
}

/** Wall-clock reading of `instant` in `tz`, straight from Intl (DST-aware). */
function wallClock(instant: Date, tz: string): WallClock {
  const parts = formatterFor(tz).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24, // some engines render midnight as "24" even with h23
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAYS.indexOf(get("weekday")),
  };
}

/** Offset of `tz` from UTC at `instant`, in minutes (e.g. -180 for America/Sao_Paulo). */
export function utcOffsetMinutes(instant: Date, tz: string = CLINIC_TIMEZONE): number {
  const w = wallClock(instant, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - instant.getTime()) / MINUTE_MS);
}

/** Offset as an ISO-8601 suffix, e.g. "-03:00" — what the LLM must put on get_availability ranges. */
export function formatOffset(instant: Date, tz: string = CLINIC_TIMEZONE): string {
  const total = utcOffsetMinutes(instant, tz);
  const sign = total < 0 ? "-" : "+";
  const abs = Math.abs(total);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

/** Read clinic-local wall-clock parts from a UTC instant (IANA zone, DST-aware). */
export function toLocalParts(instant: Date, tz: string = CLINIC_TIMEZONE): LocalParts {
  const w = wallClock(instant, tz);
  const mm = String(w.month).padStart(2, "0");
  const dd = String(w.day).padStart(2, "0");
  return {
    weekday: w.weekday,
    minutesOfDay: w.hour * 60 + w.minute,
    dateStr: `${w.year}-${mm}-${dd}`,
  };
}

/**
 * UTC instant for a clinic-local wall time (inverse of toLocalParts). Two-pass
 * inversion handles DST edges: a wall time that does not exist (spring-forward gap)
 * is shifted forward; an ambiguous one (fall-back overlap) resolves to the earlier
 * instant. Documented behaviour, pinned by tests.
 */
export function fromLocal(
  dateStr: string,
  minutesOfDay: number,
  tz: string = CLINIC_TIMEZONE,
): Date {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
  const wallAsUtcMs = Date.UTC(y, m - 1, d) + minutesOfDay * MINUTE_MS;
  const guess1 = new Date(wallAsUtcMs - utcOffsetMinutes(new Date(wallAsUtcMs), tz) * MINUTE_MS);
  const guess2 = new Date(wallAsUtcMs - utcOffsetMinutes(guess1, tz) * MINUTE_MS);
  const back = toLocalParts(guess2, tz);
  if (back.dateStr === dateStr && back.minutesOfDay === minutesOfDay) return guess2;
  // Non-existent wall time: neither guess reads back as requested → shift forward.
  return new Date(Math.max(guess1.getTime(), guess2.getTime()));
}

/** Round an instant up to the next 30-minute grid boundary (clinic-local grid). */
export function alignUpToSlot(instant: Date, tz: string = CLINIC_TIMEZONE): Date {
  const offsetMs = utcOffsetMinutes(instant, tz) * MINUTE_MS;
  const local = instant.getTime() + offsetMs;
  const aligned = Math.ceil(local / SLOT_MS) * SLOT_MS;
  return new Date(aligned - offsetMs);
}

export function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * MINUTE_MS);
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
