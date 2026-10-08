import { findUpcomingForPhone } from "../db/repositories/booking-repo.ts";
import type { Deps } from "../deps.ts";
import type { Booking } from "../domain/types.ts";

export type FindResult =
  | { kind: "found"; booking: Booking }
  | { kind: "none" }
  | { kind: "multiple"; count: number };

/**
 * The patient's single upcoming booking (006 FR-601). Read-only. The phone is the
 * conversation's — never the model's. Zero or several bookings are not guessed between:
 * the registry hands those to reception (SPEC.md US3-3).
 */
export async function findMyBooking(deps: Deps, phone: string): Promise<FindResult> {
  const upcoming = await findUpcomingForPhone(deps.pool, phone, deps.clock.now());
  if (upcoming.length === 0) return { kind: "none" };
  if (upcoming.length > 1) return { kind: "multiple", count: upcoming.length };
  return { kind: "found", booking: upcoming[0] };
}
