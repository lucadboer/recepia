/** Lowercase + strip diacritics, so pt-BR matching is accent-insensitive. */
export function normalize(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * The model writes Markdown bold (`**x**`); WhatsApp bolds with one asterisk (`*x*`) and would show
 * the doubled ones to the patient. Applied to model-written replies only — the fixed templates are
 * already WhatsApp text. Found by the README demo's live run (golden case date-06).
 */
export function toWhatsAppText(text: string): string {
  return text.replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, "*$1*");
}
