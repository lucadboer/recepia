// Patient-facing pt-BR copy (FR-208). Centralized so the orchestrator never inlines
// strings. Wording accepted as the pilot copy by the owner (T220/T221, 2026-10-06).

import {
  CalendarWriteError,
  HoldExpiredError,
  OutOfScopeError,
  SlotOutOfWindowError,
  SlotUnavailableError,
} from "../domain/errors";

export const reply = {
  escalatedToReception: () =>
    "Tudo bem! Encaminhei seu atendimento à nossa recepção e em breve alguém fala com você.",
  couldNotComplete: () =>
    "Não consegui concluir o agendamento agora; encaminhei à recepção para te ajudar.",
  textOnly: () =>
    "Por enquanto consigo ler apenas mensagens de texto. Pode escrever sua solicitação?",
  optedOut: () => "Pronto, não vou mais te enviar mensagens. Se mudar de ideia, é só chamar.",
  // Sent at most once per HANDOFF_NOTICE_INTERVAL_MS while reception owns the conversation (FR-211).
  handedOff: () =>
    "Sua solicitação está com a nossa recepção, que vai continuar o atendimento por aqui. Obrigado pela paciência!",
  // tool_result for tools the model requested AFTER escalate_to_human in the same response.
  toolCancelledAfterHandoff: () => "Conversa encaminhada à recepção; esta ação não foi executada.",
  // LGPD opt-in wording accepted by the owner (T221); counsel review recommended before a real pilot.
  askConsent: () =>
    "Para concluir, preciso da sua autorização para tratar seus dados (nome e telefone) com a finalidade de agendar sua consulta. Você autoriza? (responda SIM)",
};

/** Map a deterministic tool error to a pt-BR recovery message fed back to the loop. */
export function errorReply(err: unknown): string {
  if (err instanceof SlotUnavailableError)
    return "Esse horário acabou de ser preenchido. Quer que eu busque outros horários livres?";
  if (err instanceof SlotOutOfWindowError)
    return "Esse horário não está mais disponível para agendamento. Quer que eu busque outros horários livres?";
  if (err instanceof HoldExpiredError)
    return "A reserva expirou antes da confirmação. Posso oferecer novos horários?";
  if (err instanceof OutOfScopeError)
    return "Esse tipo de atendimento é melhor com a nossa recepção; vou te encaminhar.";
  if (err instanceof CalendarWriteError) return reply.couldNotComplete();
  return reply.couldNotComplete();
}
