import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROUTINE_TYPES } from "../config.ts";
import { formatLocalPt, formatOffset, slotLabelPt, toLocalParts } from "../domain/time.ts";
import type { Booking } from "../domain/types.ts";
import { typeLabelPt } from "../messages.ts";
import { toolDefs } from "./tool-schemas.ts";

export interface PromptContext {
  /** The instant the turn is being processed (from the injected Clock, never Date.now()). */
  now: Date;
  /** IANA zone of the clinic, e.g. "America/Sao_Paulo" (FR-213). */
  timezone: string;
  /**
   * One more dynamic line after the dated one (007: the appointment a reminder is about). It comes
   * last, so the cached static prefix stays byte-identical.
   */
  context?: string;
}

/** The versioned static block of the system prompt (FR-409). */
export interface PromptArtifact {
  /** File id, e.g. `v001`. */
  id: string;
  /** `vNNN+<sha256(file)[:7]>` — changes with any edit of the file. */
  version: string;
  /** Raw file content with `{{placeholders}}` unrendered. */
  template: string;
}

export interface SystemPrompt {
  text: string;
  version: string;
  /** `text.slice(0, cacheablePrefixLength)` is the static block — identical on every turn. */
  cacheablePrefixLength: number;
}

const PROMPTS_ROOT = fileURLToPath(new URL("../../prompts/", import.meta.url));
const DEFAULT_SYSTEM_DIR = join(PROMPTS_ROOT, "system");
const DEFAULT_CHANGELOG = join(PROMPTS_ROOT, "CHANGELOG.md");
const ARTIFACT_FILE = /^v(\d{3})\.md$/;

/**
 * Load the newest `prompts/system/vNNN.md`. Fails fast (at module load in production) when
 * no artifact exists or `prompts/CHANGELOG.md` has no `## vNNN` entry for it — a prompt
 * change without a changelog entry must not reach the model.
 */
export function loadPromptArtifact({
  systemDir = DEFAULT_SYSTEM_DIR,
  changelogPath = DEFAULT_CHANGELOG,
}: {
  systemDir?: string;
  changelogPath?: string;
} = {}): PromptArtifact {
  const candidates = existsSync(systemDir)
    ? readdirSync(systemDir)
        .map((f) => ({ file: f, n: Number(ARTIFACT_FILE.exec(f)?.[1] ?? Number.NaN) }))
        .filter((c) => Number.isFinite(c.n))
        .sort((a, b) => a.n - b.n)
    : [];
  const newest = candidates.at(-1);
  if (!newest) throw new Error(`No prompt artifact (vNNN.md) found in ${systemDir}`);
  const id = `v${String(newest.n).padStart(3, "0")}`;
  if (!existsSync(changelogPath)) {
    throw new Error(`Prompt CHANGELOG missing at ${changelogPath} (needs an entry for ${id})`);
  }
  const changelog = readFileSync(changelogPath, "utf8");
  if (!new RegExp(`^## ${id}\\b`, "m").test(changelog)) {
    throw new Error(`Prompt CHANGELOG (${changelogPath}) has no entry "## ${id}"`);
  }
  const template = readFileSync(join(systemDir, newest.file), "utf8");
  const digest = createHash("sha256").update(template).digest("hex").slice(0, 7);
  return { id, version: `${id}+${digest}`, template };
}

/** Loaded once per process: the artifact in effect for every turn. */
export const PROMPT_ARTIFACT: PromptArtifact = loadPromptArtifact();
export const PROMPT_VERSION = PROMPT_ARTIFACT.version;

// Defense-in-depth instructions live in prompts/system/vNNN.md; the REAL guarantees are the
// structural gates in tool-registry.ts + the orchestrator. Tone/clarity is measured by the
// eval judge (feature 004).
//
// Layout contract: the STATIC block comes first and the single DATED line comes LAST, so a
// prompt-cache breakpoint can later sit after the static part without being invalidated
// every minute (see 002 plan "Hardening addendum").
function renderStatic(template: string): string {
  return template
    .replaceAll("{{routine_types}}", ROUTINE_TYPES.join(", "))
    .replaceAll("{{tool_names}}", toolDefs.map((t) => t.name).join(", "))
    .trimEnd();
}

const weekdayFormatters = new Map<string, Intl.DateTimeFormat>();
function weekdayOf(now: Date, timezone: string): string {
  let f = weekdayFormatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" });
    weekdayFormatters.set(timezone, f);
  }
  return f.format(now);
}

/** The one line that changes per turn: today's weekday, date, time, zone and ISO offset. */
function datedLine({ now, timezone }: PromptContext): string {
  const { time } = formatLocalPt(now, timezone);
  const offset = formatOffset(now, timezone);
  const today = toLocalParts(now, timezone).dateStr; // ISO: unambiguous, unlike 07/15 vs 15/07
  const example = `${today}T09:00:00${offset}`;
  return (
    `Today is ${weekdayOf(now, timezone)}, ${today}, ${time} (${timezone}). ` +
    "Read 'hoje', 'amanhã' and 'semana que vem' relative to this date. " +
    `When calling get_availability, pass from/to in ISO 8601 with the offset ${offset} (e.g. ${example}); never invent times.`
  );
}

export function buildSystemPrompt(
  ctx: PromptContext,
  artifact: PromptArtifact = PROMPT_ARTIFACT,
): SystemPrompt {
  const stable = renderStatic(artifact.template);
  return {
    text: `${stable}\n\n${datedLine(ctx)}${ctx.context ? `\n${ctx.context}` : ""}`,
    version: artifact.version,
    cacheablePrefixLength: stable.length,
  };
}

/**
 * The reminder context line (007 FR-704): which appointment the patient is answering about. The
 * reminder was sent by a job, so it is not in the conversation history; this line is the model's
 * only view of it. Several pending reminders are never auto-resolved.
 */
export function reminderContextLine(pending: Booking[]): string | undefined {
  if (pending.length === 0) return undefined;
  if (pending.length > 1) {
    return `Context: the patient has ${pending.length} appointments with a pending reminder; do not confirm any on your own — use find_my_booking (several appointments go to the reception).`;
  }
  const b = pending[0];
  return `Context: the patient is answering the reminder for their ${typeLabelPt(b.appointmentType)} appointment on ${slotLabelPt(b.start)} (bookingId ${b.id}). If they confirm attendance, use confirm_attendance; to cancel or reschedule, follow the cancel/reschedule flow.`;
}
