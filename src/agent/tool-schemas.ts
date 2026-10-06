import { ROUTINE_TYPES } from "../config";
import type { LlmToolDef } from "../ports/llm-port";

/** The ONLY tools exposed to the LLM (closed allowlist). Names are stable identifiers. */
export const TOOL_NAMES = {
  availability: "get_availability",
  hold: "hold_slot",
  confirm: "confirm_booking",
  escalate: "escalate_to_human",
} as const;

export const toolDefs: LlmToolDef[] = [
  {
    name: TOOL_NAMES.availability,
    description:
      "Lista os horários de rotina realmente livres em um período (no máximo 40, os mais próximos; se `truncated` for true, consulte um período menor). É a ÚNICA fonte de horários — nunca invente horários.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Início do período (ISO 8601)" },
        to: { type: "string", description: "Fim do período (ISO 8601)" },
        type: { type: "string", enum: [...ROUTINE_TYPES] },
      },
      required: ["from", "to", "type"],
    },
  },
  {
    name: TOOL_NAMES.hold,
    description:
      "Reserva temporariamente um horário. O 'start' deve ser exatamente um horário retornado por get_availability.",
    inputSchema: {
      type: "object",
      properties: {
        start: {
          type: "string",
          description: "Início do horário (ISO 8601), exatamente como ofertado",
        },
        type: { type: "string", enum: [...ROUTINE_TYPES] },
      },
      required: ["start", "type"],
    },
  },
  {
    name: TOOL_NAMES.confirm,
    description:
      "Confirma uma reserva criada NESTA conversa, somente após a confirmação explícita do paciente.",
    inputSchema: {
      type: "object",
      properties: {
        hold_id: { type: "string" },
        patient_name: { type: "string" },
      },
      required: ["hold_id", "patient_name"],
    },
  },
  {
    name: TOOL_NAMES.escalate,
    description: "Encaminha à recepção quando o pedido sai do escopo de rotina ou na dúvida.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string" },
        context: { type: "string" },
      },
      required: ["reason", "context"],
    },
  },
];
