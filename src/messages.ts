// Patient-facing strings — Portuguese only (FR-019, constitution).

import type { AppointmentType } from "./config";
import { formatLocalPt } from "./domain/time";

const TYPE_LABELS_PT: Record<AppointmentType, string> = {
  evaluation: "avaliação",
  cleaning: "limpeza",
  follow_up: "retorno",
  consultation: "consulta",
};

/** Render an instant in clinic-local time (IANA zone, DST-aware) as DD/MM/YYYY às HH:MM. */
export function formatSlotPt(start: Date): string {
  const { date, time } = formatLocalPt(start);
  return `${date} às ${time}`;
}

export function confirmationMessagePt(type: AppointmentType, start: Date): string {
  return `Sua consulta de ${TYPE_LABELS_PT[type]} está confirmada para ${formatSlotPt(start)}. Até breve!`;
}

/** Patient: the cancellation committed with the change (006 FR-604). */
export function cancellationMessagePt(type: AppointmentType, start: Date): string {
  return `Sua consulta de ${TYPE_LABELS_PT[type]} de ${formatSlotPt(start)} foi cancelada. Se quiser marcar outro horário, é só me chamar.`;
}

/** Patient: the reschedule committed with the change (006 FR-605). */
export function rescheduledMessagePt(type: AppointmentType, from: Date, to: Date): string {
  return `Pronto! Sua consulta de ${TYPE_LABELS_PT[type]} foi remarcada de ${formatSlotPt(from)} para ${formatSlotPt(to)}. Até breve!`;
}

/** Reception: a cancel or reschedule less than 24h before the appointment (006 FR-606). */
export function lateChangeNoticePt(c: {
  change: "cancelled" | "rescheduled";
  phone: string;
  name: string | null;
  type: AppointmentType;
  start: Date;
  newStart?: Date;
}): string {
  const who = c.name ? `${c.name} (${c.phone})` : c.phone;
  const what =
    c.change === "cancelled"
      ? "cancelada pelo paciente; o horário foi liberado."
      : `remarcada para ${c.newStart ? formatSlotPt(c.newStart) : "outro horário"}; o horário original foi liberado.`;
  return [
    "Alteração com menos de 24h de antecedência.",
    `Paciente: ${who}`,
    `Consulta: ${TYPE_LABELS_PT[c.type]} em ${formatSlotPt(c.start)}`,
    `Situação: ${what}`,
  ].join("\n");
}

/** Reception: the calendar event of a cancelled booking could not be removed (006 FR-604). */
export function calendarCleanupNoticePt(c: { phone: string; start: Date }): string {
  return [
    "Não consegui remover um evento da agenda.",
    `Consulta de ${formatSlotPt(c.start)} (paciente ${c.phone}) já está cancelada no sistema.`,
    "Por favor, apague o evento manualmente.",
  ].join("\n");
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
