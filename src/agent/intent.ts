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
  /\bme tira\b/,
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

export function classifyIntent(text: string): Intent {
  const n = normalize(text);
  if (OPT_OUT.some((p) => p.test(n))) return "opt_out";
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
