import { ROUTINE_TYPES } from "../config.ts";
import type { LlmToolDef } from "../ports/llm-port.ts";

/** The ONLY tools exposed to the LLM (closed allowlist). Names are stable identifiers. */
export const TOOL_NAMES = {
  availability: "get_availability",
  hold: "hold_slot",
  confirm: "confirm_booking",
  escalate: "escalate_to_human",
  findBooking: "find_my_booking",
  cancelBooking: "cancel_booking",
  rescheduleBooking: "reschedule_booking",
  confirmAttendance: "confirm_attendance",
} as const;

export const toolDefs: LlmToolDef[] = [
  {
    name: TOOL_NAMES.availability,
    description:
      "Lists the routine times that are genuinely free in a period (at most 40, the nearest first; if `truncated` is true, ask for a shorter period). It is the ONLY source of times — never invent a time.",
    inputSchema: {
      type: "object",
      additionalProperties: false, // required by strict tool schemas
      properties: {
        from: { type: "string", description: "Start of the period (ISO 8601)" },
        to: { type: "string", description: "End of the period (ISO 8601)" },
        type: { type: "string", enum: [...ROUTINE_TYPES] },
      },
      required: ["from", "to", "type"],
    },
  },
  {
    name: TOOL_NAMES.hold,
    description:
      "Temporarily reserves a time. 'start' must be exactly a time returned by get_availability.",
    inputSchema: {
      type: "object",
      additionalProperties: false, // required by strict tool schemas
      properties: {
        start: {
          type: "string",
          description: "Start of the time (ISO 8601), exactly as offered",
        },
        type: { type: "string", enum: [...ROUTINE_TYPES] },
      },
      required: ["start", "type"],
    },
  },
  {
    name: TOOL_NAMES.confirm,
    description:
      "Confirms a hold created in THIS conversation, only after the patient's explicit confirmation.",
    inputSchema: {
      type: "object",
      additionalProperties: false, // required by strict tool schemas
      properties: {
        hold_id: { type: "string" },
        patient_name: { type: "string" },
      },
      required: ["hold_id", "patient_name"],
    },
  },
  {
    name: TOOL_NAMES.escalate,
    description:
      "Hands the conversation to the reception when the request is outside routine care, or when in doubt.",
    inputSchema: {
      type: "object",
      additionalProperties: false, // required by strict tool schemas
      properties: {
        reason: { type: "string" },
        context: { type: "string" },
      },
      required: ["reason", "context"],
    },
  },
  {
    name: TOOL_NAMES.findBooking,
    description:
      "Finds the next appointment of this conversation's patient (to cancel or reschedule it). Show the appointment to the patient and ask them to confirm; none or several appointments go to the reception automatically.",
    inputSchema: {
      type: "object",
      additionalProperties: false, // required by strict tool schemas
      properties: {},
      required: [],
    },
  },
  {
    name: TOOL_NAMES.cancelBooking,
    description:
      "Cancels the appointment returned by find_my_booking in THIS conversation, only after the patient confirmed the cancellation in a later message.",
    inputSchema: {
      type: "object",
      additionalProperties: false, // required by strict tool schemas
      properties: {
        booking_id: { type: "string", description: "bookingId returned by find_my_booking" },
      },
      required: ["booking_id"],
    },
  },
  {
    name: TOOL_NAMES.rescheduleBooking,
    description:
      "Moves the appointment returned by find_my_booking to a time held with hold_slot in THIS conversation (same appointment type), only after the patient confirmed the new time in a later message.",
    inputSchema: {
      type: "object",
      additionalProperties: false, // required by strict tool schemas
      properties: {
        booking_id: { type: "string", description: "bookingId returned by find_my_booking" },
        hold_id: { type: "string", description: "holdId returned by hold_slot" },
      },
      required: ["booking_id", "hold_id"],
    },
  },
  {
    name: TOOL_NAMES.confirmAttendance,
    description:
      "Confirms the patient's attendance at the reminder's appointment (the one named in this conversation's context) when they say they will come.",
    inputSchema: {
      type: "object",
      additionalProperties: false, // required by strict tool schemas
      properties: {
        booking_id: { type: "string", description: "bookingId of the reminder's appointment" },
      },
      required: ["booking_id"],
    },
  },
];
