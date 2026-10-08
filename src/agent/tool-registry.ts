// The closed tool allowlist + dispatch. This is where "the LLM never writes" is
// enforced STRUCTURALLY: unknown tools are rejected; a hold's start must have come
// from get_availability in this conversation; a confirm's (or a reschedule's) hold must
// have been created in this conversation; a cancel/reschedule acts only on a booking
// find_my_booking showed in this conversation, and never in the turn it was first shown
// (006). The patient phone is injected from context — never taken from LLM args.

import { AVAILABILITY_MAX_SLOTS } from "../config";
import type { Deps } from "../deps";
import { hasEscalatedFlag, LeaseLostError } from "../domain/errors";
import { slotLabelPt, toLocalIso } from "../domain/time";
import { errorTypeOf } from "../telemetry/tracing";
import { cancelBooking } from "../tools/cancel-booking";
import { confirmAttendance } from "../tools/confirm-attendance";
import { confirmBooking } from "../tools/confirm-booking";
import { escalateToHuman } from "../tools/escalate-to-human";
import { findMyBooking } from "../tools/find-my-booking";
import { getAvailability } from "../tools/get-availability";
import { holdSlot } from "../tools/hold-slot";
import { rescheduleBooking } from "../tools/reschedule-booking";
import {
  hasActiveHold,
  holdTurnOf,
  isOfferedSlot,
  markCompleted,
  markEscalated,
  recordConfirmed,
  recordHold,
  recordHoldTurn,
  recordOfferedSlots,
  recordSurfacedBooking,
  surfacedTurnOf,
} from "./conversation";
import { isChangeRequest } from "./intent";
import { errorReply } from "./reply";
import { summarizeHistory } from "./summary";
import { TOOL_NAMES } from "./tool-schemas";
import type { ConversationState } from "./types";

export interface ToolContext {
  deps: Deps;
  phone: string;
  state: ConversationState;
  now: Date;
  /** The patient message of this turn (007: attendance is never confirmed by a change request). */
  inboundText?: string;
}

export interface ToolDispatchResult {
  content: string; // tool_result content fed back to the LLM
  isError: boolean;
  state: ConversationState;
  /** The tool handed the conversation to reception — the orchestrator must stop the loop. */
  escalated: boolean;
  /**
   * The tool committed a patient-facing message (a fresh confirm_booking enqueued the
   * confirmation). Role-based, not phone-based (T235): the orchestrator suppresses its own
   * closing reply so the patient gets exactly one message (T227).
   */
  patientNotified: boolean;
  /** Which structural guardrail refused the call (telemetry, 005 FR-503). */
  rejectedBy?: RejectedBy;
  /** Error class of a tool that failed (not a guardrail rejection). */
  errorType?: string;
}

export type RejectedBy =
  | "unknown_tool"
  | "not_offered"
  | "foreign_hold"
  | "invalid_args"
  | "not_surfaced"
  | "confirmation_required"
  | "change_requested";

function result(
  state: ConversationState,
  content: string,
  isError: boolean,
  flags: Partial<
    Pick<ToolDispatchResult, "escalated" | "patientNotified" | "rejectedBy" | "errorType">
  > = {},
): ToolDispatchResult {
  return {
    content,
    isError,
    state,
    escalated: flags.escalated ?? false,
    patientNotified: flags.patientNotified ?? false,
    ...(flags.rejectedBy ? { rejectedBy: flags.rejectedBy } : {}),
    ...(flags.errorType ? { errorType: flags.errorType } : {}),
  };
}

const INVALID = { rejectedBy: "invalid_args" } as const;

const CONFIRM_FIRST =
  "Ainda não: mostre ao paciente a consulta (e o novo horário, se for remarcação) e peça a confirmação dele. Execute só depois que ele responder.";

/**
 * GUARDRAILS 4 and 5 (006): a cancel/reschedule acts only on a booking find_my_booking showed in
 * THIS conversation (`not_surfaced`), and never in the turn it was first shown — the patient must
 * have replied after seeing it (`confirmation_required`, constitution IV). Null = allowed.
 */
function lifecycleGate(state: ConversationState, bookingId: string): ToolDispatchResult | null {
  const turn = surfacedTurnOf(state, bookingId);
  if (turn === null) {
    return result(
      state,
      "Essa consulta não foi encontrada nesta conversa; use find_my_booking primeiro.",
      true,
      { rejectedBy: "not_surfaced" },
    );
  }
  if (turn >= state.turnSeq) {
    return result(state, CONFIRM_FIRST, true, { rejectedBy: "confirmation_required" });
  }
  return null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export async function dispatchTool(
  ctx: ToolContext,
  name: string,
  rawInput: unknown,
): Promise<ToolDispatchResult> {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  const { deps, phone, now } = ctx;
  let state = ctx.state;

  try {
    switch (name) {
      case TOOL_NAMES.availability: {
        const from = asString(input.from);
        const to = asString(input.to);
        const type = asString(input.type);
        if (!from || !to || !type) {
          return result(state, "Argumentos inválidos para get_availability.", true, INVALID);
        }
        const all = await getAvailability(deps, { from: new Date(from), to: new Date(to) }, type);
        // Expose at most AVAILABILITY_MAX_SLOTS (the earliest). What the model sees is EXACTLY
        // what is recorded as offered, so gate 2 never rejects a slot the model could quote.
        const truncated = all.length > AVAILABILITY_MAX_SLOTS;
        const slots = truncated ? all.slice(0, AVAILABILITY_MAX_SLOTS) : all;
        const iso = slots.map((s) => s.start.toISOString());
        state = recordOfferedSlots(state, iso, now);
        // Clinic-local times + a pt-BR label (002 FR-213): the model quotes them as is instead of
        // converting UTC in front of the patient. `offeredSlots` keeps the normalized instants.
        return result(
          state,
          JSON.stringify({
            slots: slots.map((s) => ({
              start: toLocalIso(s.start),
              end: toLocalIso(s.end),
              label: slotLabelPt(s.start),
              type: s.type,
            })),
            truncated,
          }),
          false,
        );
      }

      case TOOL_NAMES.hold: {
        const start = asString(input.start);
        const type = asString(input.type);
        if (!start || !type) {
          return result(state, "Argumentos inválidos para hold_slot.", true, INVALID);
        }
        // GUARDRAIL 2: the slot must have been offered by get_availability in this conversation.
        if (!isOfferedSlot(state, new Date(start).toISOString())) {
          return result(
            state,
            "Esse horário não foi oferecido nesta conversa; consulte a disponibilidade primeiro.",
            true,
            { rejectedBy: "not_offered" },
          );
        }
        const hold = await holdSlot(deps, { start: new Date(start), type }, { phone });
        state = recordHoldTurn(recordHold(state, hold.id, now), hold.id, now);
        return result(
          state,
          JSON.stringify({
            holdId: hold.id,
            start: toLocalIso(hold.slot.start),
            label: slotLabelPt(hold.slot.start),
            expiresAt: toLocalIso(hold.expiresAt),
          }),
          false,
        );
      }

      case TOOL_NAMES.confirm: {
        const holdId = asString(input.hold_id);
        const patientName = asString(input.patient_name);
        if (!holdId || !patientName) {
          return result(state, "Argumentos inválidos para confirm_booking.", true, INVALID);
        }
        // GUARDRAIL 3: only confirm a hold created in THIS conversation.
        if (!hasActiveHold(state, holdId)) {
          return result(state, "Reserva não reconhecida nesta conversa.", true, {
            rejectedBy: "foreign_hold",
          });
        }
        const { booking, outcome } = await confirmBooking(deps, holdId, {
          phone,
          name: patientName,
        });
        state = recordConfirmed(state, booking.id, now);
        return result(
          state,
          JSON.stringify({
            bookingId: booking.id,
            status: booking.status,
            start: toLocalIso(booking.start),
            label: slotLabelPt(booking.start),
          }),
          false,
          { patientNotified: outcome === "confirmed" },
        );
      }

      case TOOL_NAMES.findBooking: {
        const found = await findMyBooking(deps, phone);
        if (found.kind !== "found") {
          // SPEC.md US3-3: never guess between zero or several bookings — reception decides, by code.
          const reason = found.kind === "none" ? "booking_not_found" : "multiple_bookings";
          const context =
            found.kind === "none"
              ? "Paciente pediu para alterar uma consulta, mas não há consulta futura ativa para este telefone."
              : `Paciente pediu para alterar uma consulta e tem ${found.count} consultas futuras ativas.`;
          await escalateToHuman(deps, {
            reason,
            phone,
            context,
            summary: summarizeHistory(state.history),
          });
          state = markEscalated(state, now);
          return result(state, JSON.stringify({ escalated: true, reason }), false, {
            escalated: true,
          });
        }
        const b = found.booking;
        state = recordSurfacedBooking(state, b.id, now);
        return result(
          state,
          JSON.stringify({
            bookingId: b.id,
            start: toLocalIso(b.start),
            end: toLocalIso(b.end),
            label: slotLabelPt(b.start),
            type: b.appointmentType,
            status: b.status,
          }),
          false,
        );
      }

      case TOOL_NAMES.cancelBooking: {
        const bookingId = asString(input.booking_id);
        if (!bookingId) {
          return result(state, "Argumentos inválidos para cancel_booking.", true, INVALID);
        }
        const refused = lifecycleGate(state, bookingId);
        if (refused) return refused;
        const { booking, outcome } = await cancelBooking(deps, bookingId, phone);
        state = markCompleted(state, now);
        return result(
          state,
          JSON.stringify({
            bookingId: booking.id,
            status: booking.status,
            start: toLocalIso(booking.start),
            label: slotLabelPt(booking.start),
          }),
          false,
          { patientNotified: outcome === "cancelled" },
        );
      }

      case TOOL_NAMES.rescheduleBooking: {
        const bookingId = asString(input.booking_id);
        const holdId = asString(input.hold_id);
        if (!bookingId || !holdId) {
          return result(state, "Argumentos inválidos para reschedule_booking.", true, INVALID);
        }
        const refused = lifecycleGate(state, bookingId);
        if (refused) return refused;
        // GUARDRAIL 3 (reused): the new time must be a hold created in THIS conversation...
        if (!hasActiveHold(state, holdId)) {
          return result(state, "Reserva não reconhecida nesta conversa.", true, {
            rejectedBy: "foreign_hold",
          });
        }
        // ...that the patient saw before this turn (006 FR-603).
        const holdTurn = holdTurnOf(state, holdId);
        if (holdTurn === null || holdTurn >= state.turnSeq) {
          return result(state, CONFIRM_FIRST, true, { rejectedBy: "confirmation_required" });
        }
        const r = await rescheduleBooking(deps, bookingId, holdId, phone);
        state = recordConfirmed(state, r.booking.id, now);
        return result(
          state,
          JSON.stringify({
            bookingId: r.booking.id,
            previousBookingId: r.previous.id,
            status: r.booking.status,
            start: toLocalIso(r.booking.start),
            label: slotLabelPt(r.booking.start),
          }),
          false,
          { patientNotified: r.outcome === "rescheduled" },
        );
      }

      case TOOL_NAMES.confirmAttendance: {
        const bookingId = asString(input.booking_id);
        if (!bookingId) {
          return result(state, "Argumentos inválidos para confirm_attendance.", true, INVALID);
        }
        // GUARDRAIL 4 only: the booking must be the one shown in this conversation (the reminder's,
        // pre-recorded by the orchestrator, or find_my_booking's). Confirming attendance is not
        // destructive, so no confirmation round trip (007 FR-704).
        if (surfacedTurnOf(state, bookingId) === null) {
          return result(
            state,
            "Essa consulta não foi encontrada nesta conversa; use find_my_booking primeiro.",
            true,
            { rejectedBy: "not_surfaced" },
          );
        }
        // "Sim, mas preciso mudar" is a change request, never a confirmation (007 live run).
        if (ctx.inboundText !== undefined && isChangeRequest(ctx.inboundText)) {
          return result(
            state,
            "O paciente pediu uma mudança nesta mensagem; não confirme a presença. Siga o fluxo de cancelar ou remarcar.",
            true,
            { rejectedBy: "change_requested" },
          );
        }
        const { booking, outcome } = await confirmAttendance(deps, bookingId, phone, "model");
        state = markCompleted(state, now);
        return result(
          state,
          JSON.stringify({
            bookingId: booking.id,
            status: booking.status,
            start: toLocalIso(booking.start),
            label: slotLabelPt(booking.start),
          }),
          false,
          { patientNotified: outcome === "confirmed" },
        );
      }

      case TOOL_NAMES.escalate: {
        const reason = asString(input.reason) ?? "unspecified";
        const context = asString(input.context) ?? "";
        await escalateToHuman(deps, {
          reason,
          phone,
          context,
          summary: summarizeHistory(state.history),
        });
        state = markEscalated(state, now);
        return result(state, JSON.stringify({ escalated: true }), false, { escalated: true });
      }

      default:
        // GUARDRAIL 1: closed allowlist — the LLM cannot invoke anything else.
        return result(state, `Ferramenta desconhecida: ${name}`, true, {
          rejectedBy: "unknown_tool",
        });
    }
  } catch (e) {
    // The turn lost its message to another worker (008): it ends here, nothing for the model.
    if (e instanceof LeaseLostError) throw e;
    // A tool may have escalated internally BEFORE failing (confirm_booking on persistent
    // calendar failure / orphan compensation). Surface it so the orchestrator hands the
    // conversation off instead of letting the model carry on — reception is not notified twice.
    const escalated = hasEscalatedFlag(e);
    if (escalated) state = markEscalated(state, now);
    const errorType = errorTypeOf(e);
    return result(state, errorReply(e), true, { escalated, errorType });
  }
}
