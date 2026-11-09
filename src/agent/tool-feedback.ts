// What the model reads back when a tool call cannot go ahead. Model-facing text is English (prompt
// v004, ADR 0012); what the patient reads stays in Brazilian Portuguese in reply.ts / messages.ts.

import {
  BookingNotChangeableError,
  BookingNotFoundError,
  CalendarWriteError,
  HoldExpiredError,
  InvalidRescheduleError,
  OutOfScopeError,
  SlotOutOfWindowError,
  SlotUnavailableError,
} from "../domain/errors.ts";

export const toolFeedback = {
  /** A tool asked for after the conversation was already handed to the reception (T244). */
  cancelledAfterHandoff: () =>
    "The conversation was handed to the reception; this action was not run.",
};

/** The tool result for a failed tool call: what happened, and what to offer the patient next. */
export function errorFeedback(err: unknown): string {
  if (err instanceof SlotUnavailableError)
    return "That time was just taken. Offer to look for other free times.";
  if (err instanceof SlotOutOfWindowError)
    return "That time is outside the booking window and can no longer be booked. Offer to look for other free times.";
  if (err instanceof HoldExpiredError)
    return "The hold expired before the patient confirmed. Offer new times.";
  if (err instanceof OutOfScopeError)
    return "That appointment type is not routine care; hand the conversation to the reception.";
  if (err instanceof CalendarWriteError)
    return "The booking could not be completed; the conversation was handed to the reception.";
  if (err instanceof BookingNotFoundError)
    return "There is no such appointment for this phone. If the patient insists, hand the conversation to the reception.";
  if (err instanceof BookingNotChangeableError)
    return "This appointment can no longer be changed here (it has started or is not active). Offer to hand the conversation to the reception.";
  if (err instanceof InvalidRescheduleError)
    return `${err.message} Offer another time of the same appointment type.`;
  return "The action could not be completed. Tell the patient and offer the reception's help.";
}
