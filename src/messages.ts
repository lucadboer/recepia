// Patient-facing strings — Portuguese only (FR-019, constitution).

import { type AppointmentType, CLINIC_TIMEZONE } from "./config.ts";
import { formatLocalPt } from "./domain/time.ts";

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

const weekdayLongPt = new Map<string, Intl.DateTimeFormat>();

/**
 * How a person says an appointment time in a chat, in clinic-local time: "quarta, 24/06, às 17h"
 * or "segunda, 22/06, às 9h30". Used in the patient's session messages; reception notices and the
 * reminder (which mirrors an approved WhatsApp template) keep the full DD/MM/YYYY às HH:MM.
 */
export function friendlySlotPt(start: Date, tz: string = CLINIC_TIMEZONE): string {
  let f = weekdayLongPt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, weekday: "long" });
    weekdayLongPt.set(tz, f);
  }
  const weekday = f.format(start).replace(/-feira$/, "");
  const { date, time } = formatLocalPt(start, tz);
  const [hh, mi] = time.split(":") as [string, string];
  const hour = `${Number(hh)}h${mi === "00" ? "" : mi}`;
  return `${weekday}, ${date.slice(0, 5)}, às ${hour}`;
}

// Session messages below: warm but brief, and phrased so they also read right when the
// appointment is for someone else (a parent booking for a child) — no "sua" in front of it.

export function confirmationMessagePt(type: AppointmentType, start: Date): string {
  return `Prontinho! Consulta de ${TYPE_LABELS_PT[type]} confirmada para ${friendlySlotPt(start)}. Até lá! 😊`;
}

/** Patient: the cancellation committed with the change (006 FR-604). */
export function cancellationMessagePt(type: AppointmentType, start: Date): string {
  return `Pronto, a consulta de ${TYPE_LABELS_PT[type]} de ${friendlySlotPt(start)} foi cancelada. Quando quiser marcar outro horário, é só me chamar por aqui.`;
}

/** Patient: the reschedule committed with the change (006 FR-605). */
export function rescheduledMessagePt(type: AppointmentType, from: Date, to: Date): string {
  return `Prontinho! A consulta de ${TYPE_LABELS_PT[type]} foi remarcada de ${friendlySlotPt(from)} para ${friendlySlotPt(to)}. Até lá!`;
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
  return `Que bom! Presença confirmada na consulta de ${TYPE_LABELS_PT[type]} de ${friendlySlotPt(start)}. Te esperamos!`;
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
