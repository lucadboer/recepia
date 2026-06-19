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

/** A real adapter was used without its credentials (needs-creds boundary). */
export class NotConfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotConfigured";
  }
}

/** The LLM tool-use loop hit its safety cap without finishing. */
export class MaxIterationsExceeded extends Error {
  constructor(message = "Limite de iterações da conversa excedido.") {
    super(message);
    this.name = "MaxIterationsExceeded";
  }
}
