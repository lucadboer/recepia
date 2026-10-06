/** Explicit, recoverable booking errors. Never thrown silently. */

export class SlotUnavailableError extends Error {
  constructor(message = "O horário não está mais disponível.") {
    super(message);
    this.name = "SlotUnavailableError";
  }
}

export class HoldExpiredError extends Error {
  constructor(message = "A reserva expirou.") {
    super(message);
    this.name = "HoldExpiredError";
  }
}

export class OutOfScopeError extends Error {
  constructor(public readonly requestedType: string) {
    super(`Tipo fora do escopo de rotina: ${requestedType}`);
    this.name = "OutOfScopeError";
  }
}

export class CalendarWriteError extends Error {
  constructor(message = "Falha ao gravar o evento na agenda.") {
    super(message);
    this.name = "CalendarWriteError";
  }
}

export class MessagingSendError extends Error {
  constructor(message = "Falha ao enviar a mensagem.") {
    super(message);
    this.name = "MessagingSendError";
  }
}

/** A real adapter was used without its credentials (needs-creds boundary). */
export class NotConfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotConfigured";
  }
}

/**
 * Another turn persisted this phone's conversation state first (optimistic concurrency,
 * T240). The caller must NOT retry the LLM turn: tool writes already committed are
 * idempotent, and re-running could duplicate side-effects. Phone is masked in the message.
 */
export class ConversationConflictError extends Error {
  constructor(
    public readonly phone: string,
    public readonly expectedVersion: number,
  ) {
    super(
      `Conversation state for ***${phone.slice(-4)} changed concurrently (expected version ${expectedVersion}).`,
    );
    this.name = "ConversationConflictError";
  }
}

/** The LLM tool-use loop hit its safety cap without finishing. */
export class MaxIterationsExceeded extends Error {
  constructor(message = "Limite de iterações da conversa excedido.") {
    super(message);
    this.name = "MaxIterationsExceeded";
  }
}
