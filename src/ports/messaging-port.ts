/**
 * An approved WhatsApp message template (official channel): business-initiated messages outside
 * the 24 h customer-service window must use one (007). Plain-text channels ignore it.
 */
export interface MessageTemplate {
  name: string;
  /** Template language code, e.g. "pt_BR". */
  language: string;
  /** Body parameters, in order ({{1}}, {{2}}, …). No line breaks (a Cloud API rule). */
  params: string[];
}

/** Outbound messaging (WhatsApp in production: Evolution API then Cloud API). */
export interface MessagingPort {
  /**
   * `body` is a pt-BR string (FR-019) and is always sent by text-only channels; `template`, when
   * given, is what an official channel sends instead (007 FR-707).
   */
  sendMessage(to: string, body: string, template?: MessageTemplate): Promise<void>;
}
