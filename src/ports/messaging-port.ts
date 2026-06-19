/** Outbound messaging (WhatsApp in production: Evolution API then Cloud API). */
export interface MessagingPort {
  /** `body` is a pt-BR string (FR-019). */
  sendMessage(to: string, body: string): Promise<void>;
}
