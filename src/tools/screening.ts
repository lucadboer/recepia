import { isRoutineType } from "../config.ts";
import type { Deps } from "../deps.ts";
import { escalateToHuman } from "./escalate-to-human.ts";

/**
 * US3 guard: a routine type passes (returns true). Anything else is escalated to
 * reception (no booking attempted) and returns false.
 *
 * Note: detecting non-routine intent from free-text (e.g., recognizing "Invisalign"
 * or pain in a message) is the conversational layer's job and is deferred to that
 * slice. This enforces the deterministic routine-type allowlist.
 */
export async function screenRoutineType(
  deps: Deps,
  type: string,
  context: string,
): Promise<boolean> {
  if (isRoutineType(type)) return true;
  await escalateToHuman(deps, { reason: `non_routine:${type}`, phone: null, context });
  return false;
}
