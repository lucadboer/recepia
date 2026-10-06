// The closed tool allowlist + dispatch. This is where "the LLM never writes" is
// enforced STRUCTURALLY: unknown tools are rejected; a hold's start must have come
// from get_availability in this conversation; a confirm's hold must have been
// created in this conversation. The patient phone is injected from context — never
// taken from LLM args.

import type { Deps } from "../deps";
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
  escalated: boolean;
}

function result(
  state: ConversationState,
  content: string,
  isError: boolean,
  escalated = false,
): ToolDispatchResult {
  return { content, isError, state, escalated };
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
          return result(state, "Argumentos inválidos para get_availability.", true);
        }
        const slots = await getAvailability(deps, { from: new Date(from), to: new Date(to) }, type);
        const iso = slots.map((s) => s.start.toISOString());
        state = recordOfferedSlots(state, iso, now);
        return result(
          state,
          JSON.stringify({
            slots: slots.map((s) => ({
              start: s.start.toISOString(),
              end: s.end.toISOString(),
              type: s.type,
            })),
          }),
          false,
        );
      }

      case TOOL_NAMES.hold: {
        const start = asString(input.start);
        const type = asString(input.type);
        if (!start || !type) return result(state, "Argumentos inválidos para hold_slot.", true);
        // GUARDRAIL 2: the slot must have been offered by get_availability in this conversation.
        if (!isOfferedSlot(state, new Date(start).toISOString())) {
          return result(
            state,
            "Esse horário não foi oferecido nesta conversa; consulte a disponibilidade primeiro.",
            true,
          );
        }
        const hold = await holdSlot(deps, { start: new Date(start), type }, { phone });
        state = recordHold(state, hold.id, now);
        return result(
          state,
          JSON.stringify({
            holdId: hold.id,
            start: hold.slot.start.toISOString(),
            expiresAt: hold.expiresAt.toISOString(),
          }),
          false,
        );
      }

      case TOOL_NAMES.confirm: {
        const holdId = asString(input.hold_id);
        const patientName = asString(input.patient_name);
        if (!holdId || !patientName) {
          return result(state, "Argumentos inválidos para confirm_booking.", true);
        }
        // GUARDRAIL 3: only confirm a hold created in THIS conversation.
        if (!hasActiveHold(state, holdId)) {
          return result(state, "Reserva não reconhecida nesta conversa.", true);
        }
        const booking = await confirmBooking(deps, holdId, { phone, name: patientName });
        state = recordConfirmed(state, booking.id, now);
        return result(
          state,
          JSON.stringify({
            bookingId: booking.id,
            status: booking.status,
            start: booking.start.toISOString(),
          }),
          false,
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
        return result(state, JSON.stringify({ escalated: true }), false, true);
      }

      default:
        // GUARDRAIL 1: closed allowlist — the LLM cannot invoke anything else.
        return result(state, `Ferramenta desconhecida: ${name}`, true);
    }
  } catch (e) {
    return result(state, errorReply(e), true);
  }
}
