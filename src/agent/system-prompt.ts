import { ROUTINE_TYPES } from "../config";
import { formatLocalPt, formatOffset, toLocalParts } from "../domain/time";
import { toolDefs } from "./tool-schemas";

export interface PromptContext {
  /** The instant the turn is being processed (from the injected Clock, never Date.now()). */
  now: Date;
  /** IANA zone of the clinic, e.g. "America/Sao_Paulo" (FR-213). */
  timezone: string;
}

// Defense-in-depth instructions; the REAL guarantees are the structural gates in
// tool-registry.ts + the orchestrator. TODO(product): persona/tone/wording is placeholder.
//
// Layout contract: the STATIC block comes first and the single DATED line comes LAST, so
// a prompt-cache breakpoint can later sit after the static part without being invalidated
// every minute (see plan.md "Hardening addendum").
const STATIC_LINES = [
  "Você é a secretária virtual de uma clínica odontológica. Responda em português, de forma clara e cordial.",
  "",
  "Regras invioláveis:",
  "- Ofereça apenas horários retornados por get_availability; nunca invente horários.",
  "- Você nunca grava nada diretamente: aja somente pelas ferramentas disponíveis.",
  "- Só chame confirm_booking depois que o paciente confirmar explicitamente um horário oferecido.",
  "- Na dúvida ou fora de rotina (dor/urgência, Invisalign, ortodontia, implante, cirurgia, tratamento em andamento, dentista específico, reclamação, preço/convênio), use escalate_to_human.",
  `- Tipos de rotina atendidos: ${ROUTINE_TYPES.join(", ")}.`,
  "",
  // [draft] TODO(product): wording/tom abaixo é rascunho para revisão — NÃO é final.
  "Estilo e exemplos de fala [draft] (adapte ao contexto; não recite literalmente):",
  '- Saudação: "Oi! Aqui é a assistente virtual da clínica 🦷. Posso te ajudar a agendar uma consulta de rotina?"',
  '- Oferta de horários: "Tenho estes horários livres: 1) ter, 24/06 às 14h · 2) qua, 25/06 às 09h30. Qual fica melhor pra você?"',
  '- Pedido de confirmação: "Então fica limpeza na ter, 24/06 às 14h. Posso confirmar? (responda SIM)"',
  "",
  `Ferramentas disponíveis: ${toolDefs.map((t) => t.name).join(", ")}.`,
  "",
];

const weekdayFormatters = new Map<string, Intl.DateTimeFormat>();
function weekdayPt(now: Date, timezone: string): string {
  let f = weekdayFormatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("pt-BR", { timeZone: timezone, weekday: "long" });
    weekdayFormatters.set(timezone, f);
  }
  return f.format(now);
}

/** The one line that changes per turn: today's weekday, date, time, zone and ISO offset. */
export function datedLine({ now, timezone }: PromptContext): string {
  const { date, time } = formatLocalPt(now, timezone);
  const offset = formatOffset(now, timezone);
  const example = `${toLocalParts(now, timezone).dateStr}T09:00:00${offset}`;
  return (
    `Hoje é ${weekdayPt(now, timezone)}, ${date}, ${time} (${timezone}). ` +
    "Interprete 'hoje', 'amanhã' e 'semana que vem' a partir desta data. " +
    `Ao chamar get_availability, passe from/to em ISO 8601 com o offset ${offset} (ex.: ${example}); nunca invente horários.`
  );
}

export function buildSystemPrompt(ctx: PromptContext): string {
  return [...STATIC_LINES, datedLine(ctx)].join("\n");
}
