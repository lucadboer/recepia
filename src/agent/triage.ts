// Deterministic escalation-signal detector — the "escalar na dúvida" backstop that
// runs BEFORE the LLM. Accent-insensitive keyword/regex over the constitution's
// trigger categories. Conservative by design (assert-tested per category).

import { normalize } from "./text.ts";

export interface TriageResult {
  escalate: boolean;
  reason?: string;
}

const CATEGORIES: ReadonlyArray<{ reason: string; patterns: RegExp[] }> = [
  {
    reason: "urgency",
    patterns: [
      /\bdor(es)?\b/,
      /\bdoendo\b/,
      /\bdoi\b/,
      /\burgen\w*/,
      /\bemergenci\w*/,
      /\bsangra\w*/,
      /\binchad\w*/,
    ],
  },
  {
    reason: "specialized_procedure",
    patterns: [
      /\binvisalign\b/,
      /\bortodont\w*/,
      /\baparelho\b/,
      /\bimplante\b/,
      /\bcirurgia\b/,
      /\bcanal\b/,
      /\bprotese\b/,
      /\bextracao\b/,
      /\bsiso\b/,
    ],
  },
  {
    reason: "ongoing_treatment",
    patterns: [
      /\bem tratamento\b/,
      /\btratamento em andamento\b/,
      /\bmeu tratamento\b/,
      /\bcontinuar o tratamento\b/,
    ],
  },
  {
    reason: "specific_professional",
    patterns: [/\bdra?\b/, /\bdoutora?\b/],
  },
  {
    reason: "complaint",
    patterns: [/\breclama\w*/, /\bprocessar\b/, /\binsatisfeit\w*/, /\bpessim\w*/, /\bhorrivel\b/],
  },
  {
    reason: "financial",
    patterns: [
      /\bpreco\b/,
      /\bvalor(es)?\b/,
      /\bquanto custa\b/,
      /\bconvenio\b/,
      /\bplano\b/,
      /\bparcel\w*/,
      /\bdesconto\b/,
      /\borcamento\b/,
      /\bpagamento\b/,
    ],
  },
  {
    reason: "human_requested",
    patterns: [
      /\batendente\b/,
      /\bhumano\b/,
      /\brecepcao\b/,
      /\bfalar com (alguem|atendente|uma pessoa)\b/,
    ],
  },
];

export function triage(text: string): TriageResult {
  const n = normalize(text);
  for (const category of CATEGORIES) {
    if (category.patterns.some((p) => p.test(n))) {
      return { escalate: true, reason: category.reason };
    }
  }
  return { escalate: false };
}
