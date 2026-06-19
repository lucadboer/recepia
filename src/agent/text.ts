/** Lowercase + strip diacritics, so pt-BR matching is accent-insensitive. */
export function normalize(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}
