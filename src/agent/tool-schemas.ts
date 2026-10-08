import { ROUTINE_TYPES } from "../config";
import type { LlmToolDef } from "../ports/llm-port";

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
      "Lista os horários de rotina realmente livres em um período (no máximo 40, os mais próximos; se `truncated` for true, consulte um período menor). É a ÚNICA fonte de horários — nunca invente horários.",
    inputSchema: {
      type: "object",
      additionalProperties: false, // required by strict tool schemas
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
      additionalProperties: false, // required by strict tool schemas
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
    description: "Encaminha à recepção quando o pedido sai do escopo de rotina ou na dúvida.",
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
      "Busca a próxima consulta do paciente desta conversa (para cancelar ou remarcar). Mostre a consulta ao paciente e peça a confirmação dele; nenhuma ou várias consultas vão para a recepção automaticamente.",
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
      "Cancela a consulta retornada por find_my_booking NESTA conversa, somente depois que o paciente confirmou o cancelamento em uma mensagem posterior.",
    inputSchema: {
      type: "object",
      additionalProperties: false, // required by strict tool schemas
      properties: {
        booking_id: { type: "string", description: "bookingId retornado por find_my_booking" },
      },
      required: ["booking_id"],
    },
  },
  {
    name: TOOL_NAMES.rescheduleBooking,
    description:
      "Remarca a consulta retornada por find_my_booking para um horário reservado com hold_slot NESTA conversa (mesmo tipo de consulta), somente depois que o paciente confirmou o novo horário em uma mensagem posterior.",
    inputSchema: {
      type: "object",
      additionalProperties: false, // required by strict tool schemas
      properties: {
        booking_id: { type: "string", description: "bookingId retornado por find_my_booking" },
        hold_id: { type: "string", description: "holdId retornado por hold_slot" },
      },
      required: ["booking_id", "hold_id"],
    },
  },
  {
    name: TOOL_NAMES.confirmAttendance,
    description:
      "Confirma a presença do paciente na consulta do lembrete (a consulta indicada no contexto desta conversa), quando ele disser que vai comparecer.",
    inputSchema: {
      type: "object",
      additionalProperties: false, // required by strict tool schemas
      properties: {
        booking_id: { type: "string", description: "bookingId da consulta do lembrete" },
      },
      required: ["booking_id"],
    },
  },
];
