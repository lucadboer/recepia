// Patient-facing strings — Portuguese only (FR-019, constitution).

import type { AppointmentType } from "./config";
import { formatLocalPt } from "./domain/time";

const TYPE_LABELS_PT: Record<AppointmentType, string> = {
  evaluation: "avaliação",
  cleaning: "limpeza",
  follow_up: "retorno",
  consultation: "consulta",
};

/** pt-BR name of an appointment type (also used in the model's reminder context, 007). */
export function typeLabelPt(type: AppointmentType): string {
  return TYPE_LABELS_PT[type];
}

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

interface ReminderInput {
  name: string | null;
  type: AppointmentType;
  start: Date;
}

function firstName(name: string | null): string | null {
  const first = name?.split(/\s+/).find((w) => w.length > 0);
  return first ?? null;
}

/** Patient: the reminder ~24h before (007 FR-701). Never marketing. */
export function reminderMessagePt(r: ReminderInput): string {
  const hello = firstName(r.name) ? `Olá, ${firstName(r.name)}!` : "Olá!";
  return `${hello} Lembrete da sua consulta de ${TYPE_LABELS_PT[r.type]} em ${formatSlotPt(r.start)}. Você confirma presença? Responda SIM para confirmar, ou me diga se precisa remarcar ou cancelar.`;
}

/**
 * Body parameters of the approved reminder template (official channel, 007 FR-707), in order:
 * first name, appointment type, date and time. Cloud API forbids line breaks and tabs inside them.
 */
export function reminderTemplateParams(r: ReminderInput): string[] {
  const clean = (s: string) => s.replace(/[\n\t\r]+/g, " ").trim();
  return [
    clean(firstName(r.name) ?? "paciente"),
    clean(TYPE_LABELS_PT[r.type]),
    clean(formatSlotPt(r.start)),
  ];
}

/** Patient: attendance confirmed after the reminder (007 FR-703). */
export function attendanceConfirmedMessagePt(type: AppointmentType, start: Date): string {
  return `Presença confirmada na sua consulta de ${TYPE_LABELS_PT[type]} em ${formatSlotPt(start)}. Até lá!`;
}

/** Reception: the patient did not answer the reminder (007 FR-705). */
export function unconfirmedNoticePt(c: {
  name: string | null;
  phone: string;
  type: AppointmentType;
  start: Date;
}): string {
  const who = c.name ? `${c.name} (${c.phone})` : c.phone;
  return [
    "Paciente não confirmou presença após o lembrete.",
    `Paciente: ${who}`,
    `Consulta: ${TYPE_LABELS_PT[c.type]} em ${formatSlotPt(c.start)}`,
    "Vale ligar para confirmar.",
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
