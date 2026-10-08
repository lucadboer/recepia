// The closed tool allowlist + dispatch. This is where "the LLM never writes" is
// enforced STRUCTURALLY: unknown tools are rejected; a hold's start must have come
// from get_availability in this conversation; a confirm's hold must have been
// created in this conversation. The patient phone is injected from context — never
// taken from LLM args.

import { AVAILABILITY_MAX_SLOTS } from "../config";
import type { Deps } from "../deps";
import { hasEscalatedFlag } from "../domain/errors";
import { slotLabelPt, toLocalIso } from "../domain/time";
import { errorTypeOf } from "../telemetry/tracing";
import { confirmBooking } from "../tools/confirm-booking";
import { escalateToHuman } from "../tools/escalate-to-human";
import { getAvailability } from "../tools/get-availability";
import { holdSlot } from "../tools/hold-slot";
import {
  hasActiveHold,
  isOfferedSlot,
  markEscalated,
  recordConfirmed,
  recordHold,
  recordOfferedSlots,
} from "./conversation";
import { errorReply } from "./reply";
import { summarizeHistory } from "./summary";
import { TOOL_NAMES } from "./tool-schemas";
import type { ConversationState } from "./types";

export interface ToolContext {
  deps: Deps;
  phone: string;
  state: ConversationState;
  now: Date;
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
  | "confirmation_required";

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
        state = recordHold(state, hold.id, now);
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
    // A tool may have escalated internally BEFORE failing (confirm_booking on persistent
    // calendar failure / orphan compensation). Surface it so the orchestrator hands the
    // conversation off instead of letting the model carry on — reception is not notified twice.
    const escalated = hasEscalatedFlag(e);
    if (escalated) state = markEscalated(state, now);
    const errorType = errorTypeOf(e);
    return result(state, errorReply(e), true, { escalated, errorType });
  }
}
