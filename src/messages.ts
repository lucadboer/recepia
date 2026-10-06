// Patient-facing strings — Portuguese only (FR-019, constitution).

import type { AppointmentType } from "./config";
import { toLocalParts } from "./domain/time";

const TYPE_LABELS_PT: Record<AppointmentType, string> = {
  evaluation: "avaliação",
  cleaning: "limpeza",
  follow_up: "retorno",
  consultation: "consulta",
};

/** Render an instant in clinic-local time (IANA zone, DST-aware) as DD/MM/YYYY às HH:MM. */
export function formatSlotPt(start: Date): string {
  const { dateStr, minutesOfDay } = toLocalParts(start);
  const [yyyy, mm, dd] = dateStr.split("-") as [string, string, string];
  const hh = String(Math.floor(minutesOfDay / 60)).padStart(2, "0");
  const mi = String(minutesOfDay % 60).padStart(2, "0");
  return `${dd}/${mm}/${yyyy} às ${hh}:${mi}`;
}

export function confirmationMessagePt(type: AppointmentType, start: Date): string {
  return `Sua consulta de ${TYPE_LABELS_PT[type]} está confirmada para ${formatSlotPt(start)}. Até breve!`;
}

/** Reception hand-off notice: who to call back, why, what was said (FR-204). Multi-line pt-BR. */
export function escalationMessagePt(e: {
  reason: string;
  phone: string | null;
  context: string;
  summary: string[];
}): string {
  const lines = ["Atendimento encaminhado à recepção."];
  if (e.phone) lines.push(`Paciente: ${e.phone}`);
  lines.push(`Motivo: ${e.reason}`);
  lines.push(`Contexto: ${e.context}`);
  if (e.summary.length > 0) {
    lines.push("Últimas mensagens:");
    for (const l of e.summary) lines.push(`- ${l}`);
  }
  return lines.join("\n");
}
