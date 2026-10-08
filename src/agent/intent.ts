// Light deterministic intent routing used by the orchestrator (opt-out is the
// LGPD "opt-out fácil" path; booking/greeting steer the conversation).

import { normalize } from "./text";

export type Intent = "opt_out" | "booking" | "greeting" | "other";

const OPT_OUT = [
  /\bdescadastr\w*/,
  /\bopt-?out\b/,
  /\bremover meus dados\b/,
  /\bnao quero (mais )?receber\b/,
  /\bcancelar cadastro\b/,
  // "me tira" off a list/registry — never "me tira dessa consulta" (007 FR-708); a bare
  // "me tira" (any punctuation) is handled in classifyIntent.
  /\bme tira (da|dessa|desta) lista\b/,
  /\bme tira daqui\b/,
  /\bme tira do (cadastro|sistema|contato|grupo)\b/,
  /\bparar de receber\b/,
];
const BOOKING = [
  /\bmarcar\b/,
  /\bagendar\b/,
  /\bagenda\b/,
  /\bhorario\b/,
  /\bconsulta\b/,
  /\blimpeza\b/,
  /\bavaliacao\b/,
  /\bretorno\b/,
];
const GREETING = [/\boi\b/, /\bola\b/, /\bbom dia\b/, /\bboa tarde\b/, /\bboa noite\b/, /\be ai\b/];

/** Letters, digits and single spaces only — "Me tira!" and " me tira " compare equal. */
function bare(n: string): string {
  return n
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const BARE_OPT_OUT = /^(me tira|me tire|me tira por favor|por favor me tira)$/;

export function classifyIntent(text: string): Intent {
  const n = normalize(text);
  if (OPT_OUT.some((p) => p.test(n)) || BARE_OPT_OUT.test(bare(n))) return "opt_out";
  if (BOOKING.some((p) => p.test(n))) return "booking";
  if (GREETING.some((p) => p.test(n))) return "greeting";
  return "other";
}

const AFFIRMATIVE = [
  /\bsim\b/,
  /\bautorizo\b/,
  /\bconcordo\b/,
  /\baceito\b/,
  /\bpode sim\b/,
  /\bclaro\b/,
  /\bisso\b/,
];

// A negation anywhere in the reply wins: "não autorizo" / "nem pensar, claro que não" must never
// be read as consent (found by the golden set, feature 004). Conservative by design: a reply
// like "não, pode sim" is treated as not-yet-consented and the agent asks again.
const NEGATION = [/\bnao\b/, /\bnem\b/, /\bjamais\b/, /\bnunca\b/, /\brecuso\b/];

/** Used only to capture an opt-in reply when the orchestrator is awaiting consent. */
export function isAffirmative(text: string): boolean {
  const n = normalize(text);
  if (NEGATION.some((p) => p.test(n))) return false;
  return AFFIRMATIVE.some((p) => p.test(n));
}

// Whole-message affirmations only (007 FR-703): what a patient answers to "Você confirma
// presença?" when the answer is unmistakable. Punctuation is ignored; any other word — "mas",
// a question, a negation, a request — sends the reply to the model instead.
const STRICT_AFFIRMATIVE = new Set([
  "sim",
  "s",
  "sim sim",
  "confirmo",
  "confirmado",
  "confirmada",
  "pode confirmar",
  "sim confirmo",
  "sim pode confirmar",
  "sim confirmado",
  "confirmo presenca",
  "confirmar presenca",
  "presenca confirmada",
  "ok",
  "okay",
  "ok confirmo",
  "estarei la",
  "vou sim",
  "sim vou",
  "sim estarei la",
  "👍",
  "sim 👍",
]);

/** True only when the WHOLE reply is a plain affirmation (no "mas", no question, no request). */
export function isStrictAffirmative(text: string): boolean {
  const n = normalize(text)
    .replace(/[.,!;:¡¿"'()…-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (n.includes("?")) return false;
  return STRICT_AFFIRMATIVE.has(n);
}

// A message that asks to change the appointment (007 review): attendance is never confirmed in
// the same message — "sim, mas preciso mudar" is a change request, not a confirmation.
const CHANGE_REQUEST = [
  /\bmudar\b/,
  /\bremarc\w*/,
  /\btroca\w*/,
  /\balter\w*/,
  /\bcancel\w*/,
  /\bdesmarc\w*/,
  /\badiar\b/,
  /\boutro (dia|horario)\b/,
  /\bnao (vou|posso|consigo|da)\b/,
];

export function isChangeRequest(text: string): boolean {
  const n = normalize(text);
  return CHANGE_REQUEST.some((p) => p.test(n));
}
