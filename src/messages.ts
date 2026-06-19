// Patient-facing strings — Portuguese only (FR-019, constitution).

import { type AppointmentType, CLINIC_UTC_OFFSET_MINUTES } from "./config";

const TYPE_LABELS_PT: Record<AppointmentType, string> = {
  evaluation: "avaliação",
  cleaning: "limpeza",
  follow_up: "retorno",
  consultation: "consulta",
};

/** Render an instant in clinic-local time (fixed offset) as DD/MM/YYYY às HH:MM. */
export function formatSlotPt(start: Date): string {
  const local = new Date(start.getTime() + CLINIC_UTC_OFFSET_MINUTES * 60_000);
  const dd = String(local.getUTCDate()).padStart(2, "0");
  const mm = String(local.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = local.getUTCFullYear();
  const hh = String(local.getUTCHours()).padStart(2, "0");
  const mi = String(local.getUTCMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yyyy} às ${hh}:${mi}`;
}

export function confirmationMessagePt(type: AppointmentType, start: Date): string {
  return `Sua consulta de ${TYPE_LABELS_PT[type]} está confirmada para ${formatSlotPt(start)}. Até breve!`;
}

export function escalationMessagePt(reason: string, context: string): string {
  return `Atendimento encaminhado à recepção. Motivo: ${reason}. Contexto: ${context}`;
}
