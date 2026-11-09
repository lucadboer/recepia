// Patient-facing pt-BR copy (FR-208). Centralized so the orchestrator never inlines
// strings. Wording accepted as the pilot copy by the owner (T220/T221, 2026-10-06); made warmer
// and less bureaucratic on 2026-11-09 (owner feedback), the LGPD opt-in text unchanged.

export const reply = {
  escalatedToReception: () =>
    "Combinado! Passei seu atendimento pra nossa recepção, e logo alguém fala com você por aqui.",
  couldNotComplete: () =>
    "Não consegui concluir o agendamento agora, mas já passei pra nossa recepção, que vai te ajudar por aqui.",
  textOnly: () =>
    "Por enquanto só consigo ler mensagens de texto. Pode me escrever o que você precisa?",
  optedOut: () => "Pronto, não vou mais te enviar mensagens. Se mudar de ideia, é só chamar.",
  // Sent at most once per HANDOFF_NOTICE_INTERVAL_MS while reception owns the conversation (FR-211).
  handedOff: () =>
    "Seu atendimento já está com a nossa recepção, que continua a conversa por aqui. Obrigado pela paciência!",
  // tool_result for tools the model requested AFTER escalate_to_human in the same response.
  // LGPD opt-in wording accepted by the owner (T221); counsel review recommended before a real pilot.
  askConsent: () =>
    "Para concluir, preciso da sua autorização para tratar seus dados (nome e telefone) com a finalidade de agendar sua consulta. Você autoriza? (responda SIM)",
};

/** Map a deterministic tool error to a pt-BR recovery message fed back to the loop. */
