import type { Booking, Hold, Slot } from "./types";

export function slotOf(b: Booking): Slot {
  return { start: b.start, end: b.end, type: b.appointmentType };
}

export function toHold(b: Booking): Hold {
  if (b.expiresAt === null) {
    throw new Error("booking is not a held reservation");
  }
  return { id: b.id, slot: slotOf(b), expiresAt: b.expiresAt };
}

export function isExpired(expiresAt: Date | null, now: Date): boolean {
  return expiresAt === null || expiresAt.getTime() <= now.getTime();
}
