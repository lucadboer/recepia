import type { Deps } from "../deps";
import { bookingWindow } from "../domain/time";
import type { Slot } from "../domain/types";
import { escalateToHuman } from "./escalate-to-human";
import { type Period, getAvailability } from "./get-availability";

/**
 * Slots for the requested window if it has capacity; otherwise the next real free
 * slots searched forward to the booking horizon. Always grid-aligned and bookable.
 */
export async function findNextSlots(
  deps: Deps,
  requested: Period,
  type: string,
  limit = 3,
): Promise<Slot[]> {
  const inWindow = await getAvailability(deps, requested, type);
  if (inWindow.length > 0) return inWindow.slice(0, limit);

  const horizonTo = bookingWindow(deps.clock.now()).to;
  const next = await getAvailability(deps, { from: requested.to, to: horizonTo }, type);
  return next.slice(0, limit);
}

/**
 * US2 wiring: offer real alternatives, or escalate to reception when nothing is
 * free anywhere in the horizon (never leave the patient without an answer — FR-014).
 */
export async function offerAlternativesOrEscalate(
  deps: Deps,
  requested: Period,
  type: string,
  limit = 3,
): Promise<Slot[]> {
  const slots = await findNextSlots(deps, requested, type, limit);
  if (slots.length === 0) {
    await escalateToHuman(
      deps,
      "no_availability",
      `Sem horários disponíveis para ${type} no horizonte de agendamento.`,
    );
  }
  return slots;
}
