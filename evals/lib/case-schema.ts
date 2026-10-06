// Golden-set case format (research R2) + hand-written validator (no schema library).
// A case is data: the patient turns, the script the stand-in model follows, the clinic
// seed and the expectations. The validator rejects anything it cannot interpret and
// enforces FR-413 (fictitious phones and names) instead of leaving it to review.

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export const CATEGORIES = [
  "happy_path",
  "alternative_slot",
  "reschedule_cancel",
  "ambiguous_date",
  "out_of_scope",
  "opt_out",
  "consent_refusal",
  "injection",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Every phone in a fixture must look like this; +5531900000000 and +5531900000999 are reserved. */
export const FICTITIOUS_PHONE = /^\+5531900000\d{3}$/;
export const RECEPTION_PHONE = "+5531900000000";
export const FOREIGN_PHONE = "+5531900000999";
export const FICTITIOUS_NAMES = [
  "Ana Teste",
  "Bruno Teste",
  "Carla Teste",
  "Diego Teste",
  "Elisa Teste",
  "Fábio Teste",
  "Gabriela Teste",
  "Heitor Teste",
  "Iara Teste",
  "João Teste",
] as const;

export const SCRIPT_PLACEHOLDER =
  /^\$(offeredSlot\[\d+\]|lastHoldId|otherConversationHoldId|foreignPhone)$/;
export const MATCHER_PLACEHOLDERS = ["$offeredSlot", "$ownHoldId", "$any"] as const;

export type Matcher =
  | string
  | number
  | boolean
  | null
  | { $in: unknown[] }
  | (typeof MATCHER_PLACEHOLDERS)[number];

export interface ExpectedCall {
  name: string;
  input?: Record<string, Matcher>;
}

export type ConversationStatus = "active" | "escalated" | "completed";

export interface Expectation {
  toolCalls?: { mustInclude?: ExpectedCall[]; mustNotInclude?: string[] };
  writes?: { holds?: number; bookings?: number; calendarEvents?: number; escalations?: number };
  escalation?: { expected: boolean; reasonIn?: string[] };
  /** Default true: every booking write happened with opt-in recorded. */
  noWriteWithoutConsent?: boolean;
  /** Default true: every held start was returned by get_availability in this conversation. */
  noHallucinatedSlots?: boolean;
  status?: ConversationStatus;
  patientMessages?: number;
  /** Exact number of model calls (0 proves the deterministic triage answered before the model). */
  llmCalls?: number;
  /** Default true: no hold/booking was written for any phone other than the patient's. */
  noForeignWrites?: boolean;
}

export interface CaseSeed {
  now: string;
  capacity: { weekday: number; start: string; end: string; capacity: number }[];
  overrides?: { date: string; start: string; end: string; capacity: number }[];
  bookings?: { start: string; phone: string; status: "confirmed" | "held"; seat?: number }[];
  consent: "none" | "opted_in" | "opted_out";
}

export interface CaseTurn {
  text: string;
  /** Provider message id; defaults to `<caseId>-<n>` (1-based). */
  id: string;
  /** Clock advance before this turn (ms), e.g. to let a hold expire. */
  delayMs?: number;
}

export type ToolMove = { tool: string; input: Record<string, unknown> };
export type ScriptMove = { text: string } | ToolMove | { tools: ToolMove[] };

export interface EvalCase {
  id: string;
  category: Category;
  title: string;
  limitation?: string;
  seed: CaseSeed;
  patient: { phone: string };
  turns: CaseTurn[];
  /** Per inbound turn, the stand-in's moves; ignored in live mode. */
  llmScript: ScriptMove[][];
  labels: { shouldEscalate: boolean; escalationReason?: string };
  expect: Expectation;
  /** When present, used INSTEAD of `expect` in live mode (looser tool-call matching). */
  liveExpect?: Expectation;
}

export class CaseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaseValidationError";
  }
}

type Obj = Record<string, unknown>;
// A function DECLARATION so TypeScript narrows after `if (!ok) fail(...)` (never-returning calls
// only narrow control flow when the callee has an explicit declaration).
function fail(msg: string): never {
  throw new CaseValidationError(msg);
}
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isInt = (v: unknown): v is number => Number.isInteger(v);

function obj(v: unknown, path: string, allowed: string[]): Obj {
  if (!isObj(v)) fail(`${path}: expected an object`);
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k)) fail(`${path}: unknown field "${k}"`);
  }
  return v;
}
function str(v: unknown, path: string, pattern?: RegExp): string {
  if (!isStr(v) || v.length === 0) fail(`${path}: expected a non-empty string`);
  if (pattern && !pattern.test(v)) fail(`${path}: "${v}" does not match ${pattern}`);
  return v;
}
function optStr(v: unknown, path: string): string | undefined {
  return v === undefined ? undefined : str(v, path);
}
function int(v: unknown, path: string, min = 0): number {
  if (!isInt(v) || v < min) fail(`${path}: expected an integer >= ${min}`);
  return v;
}
function optInt(v: unknown, path: string): number | undefined {
  return v === undefined ? undefined : int(v, path);
}
function bool(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") fail(`${path}: expected a boolean`);
  return v;
}
function optBool(v: unknown, path: string): boolean | undefined {
  return v === undefined ? undefined : bool(v, path);
}
function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(`${path}: expected an array`);
  return v;
}
function iso(v: unknown, path: string): string {
  const s = str(v, path);
  if (Number.isNaN(new Date(s).getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    fail(`${path}: expected an ISO 8601 instant, got "${s}"`);
  }
  return s;
}
function phone(v: unknown, path: string, { allowReserved = false } = {}): string {
  const s = str(v, path);
  if (!FICTITIOUS_PHONE.test(s))
    fail(`${path}: "${s}" is not a fictitious phone (${FICTITIOUS_PHONE})`);
  if (!allowReserved && (s === RECEPTION_PHONE || s === FOREIGN_PHONE)) {
    fail(`${path}: "${s}" is reserved (reception / foreign placeholder)`);
  }
  return s;
}
const HHMM = /^\d{2}:\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function seed(v: unknown): CaseSeed {
  const s = obj(v, "seed", ["now", "capacity", "overrides", "bookings", "consent"]);
  const capacity = arr(s.capacity, "seed.capacity").map((r, i) => {
    const p = `seed.capacity[${i}]`;
    const o = obj(r, p, ["weekday", "start", "end", "capacity"]);
    const weekday = int(o.weekday, `${p}.weekday`);
    if (weekday > 6) fail(`${p}.weekday: expected 0..6`);
    return {
      weekday,
      start: str(o.start, `${p}.start`, HHMM),
      end: str(o.end, `${p}.end`, HHMM),
      capacity: int(o.capacity, `${p}.capacity`),
    };
  });
  const overrides =
    s.overrides === undefined
      ? undefined
      : arr(s.overrides, "seed.overrides").map((r, i) => {
          const p = `seed.overrides[${i}]`;
          const o = obj(r, p, ["date", "start", "end", "capacity"]);
          return {
            date: str(o.date, `${p}.date`, DATE),
            start: str(o.start, `${p}.start`, HHMM),
            end: str(o.end, `${p}.end`, HHMM),
            capacity: int(o.capacity, `${p}.capacity`),
          };
        });
  const bookings =
    s.bookings === undefined
      ? undefined
      : arr(s.bookings, "seed.bookings").map((r, i) => {
          const p = `seed.bookings[${i}]`;
          const o = obj(r, p, ["start", "phone", "status", "seat"]);
          const status = str(o.status, `${p}.status`);
          if (status !== "confirmed" && status !== "held") fail(`${p}.status: confirmed | held`);
          return {
            start: iso(o.start, `${p}.start`),
            phone: phone(o.phone, `${p}.phone`),
            status: status as "confirmed" | "held",
            seat: optInt(o.seat, `${p}.seat`),
          };
        });
  const consent = str(s.consent, "seed.consent");
  if (!["none", "opted_in", "opted_out"].includes(consent)) {
    fail(`seed.consent: none | opted_in | opted_out`);
  }
  return {
    now: iso(s.now, "seed.now"),
    capacity,
    overrides,
    bookings,
    consent: consent as CaseSeed["consent"],
  };
}

const PHONE_IN_TEXT = /\+\d{8,}/g;
function checkPhonesInText(text: string, path: string): void {
  for (const m of text.match(PHONE_IN_TEXT) ?? []) {
    if (!FICTITIOUS_PHONE.test(m)) fail(`${path}: "${m}" is not a fictitious phone`);
  }
}

function turns(v: unknown, caseId: string): CaseTurn[] {
  const list = arr(v, "turns");
  if (list.length === 0) fail("turns: must not be empty");
  return list.map((t, i) => {
    const p = `turns[${i}]`;
    const o = obj(t, p, ["text", "id", "delayMs"]);
    const text = str(o.text, `${p}.text`);
    checkPhonesInText(text, `${p}.text`);
    return {
      text,
      id: optStr(o.id, `${p}.id`) ?? `${caseId}-${i + 1}`,
      delayMs: optInt(o.delayMs, `${p}.delayMs`),
    };
  });
}

function toolMove(v: unknown, path: string): ToolMove {
  const o = obj(v, path, ["tool", "input"]);
  const tool = str(o.tool, `${path}.tool`);
  if (!isObj(o.input)) fail(`${path}.input: expected an object`);
  checkScriptInput(o.input, `${path}.input`);
  return { tool, input: o.input };
}

function checkScriptInput(input: Obj, path: string): void {
  for (const [k, val] of Object.entries(input)) {
    if (isObj(val)) {
      checkScriptInput(val, `${path}.${k}`);
      continue;
    }
    if (!isStr(val)) continue;
    if (val.startsWith("$")) {
      if (!SCRIPT_PLACEHOLDER.test(val)) fail(`${path}.${k}: unresolvable placeholder "${val}"`);
      continue;
    }
    if (/^\+\d+$/.test(val)) phone(val, `${path}.${k}`, { allowReserved: true });
    if (k === "patient_name" && !(FICTITIOUS_NAMES as readonly string[]).includes(val)) {
      fail(`${path}.${k}: patient_name "${val}" is not in the fictitious names list`);
    }
  }
}

function script(v: unknown, turnCount: number): ScriptMove[][] {
  const perTurn = arr(v, "llmScript");
  if (perTurn.length < turnCount) {
    fail(`llmScript: shorter than turns (${perTurn.length} < ${turnCount})`);
  }
  return perTurn.map((moves, t) =>
    arr(moves, `llmScript[${t}]`).map((m, i): ScriptMove => {
      const p = `llmScript[${t}][${i}]`;
      if (!isObj(m)) fail(`${p}: expected a move object`);
      const keys = Object.keys(m);
      if (keys.length === 1 && keys[0] === "text") return { text: str(m.text, `${p}.text`) };
      if (keys.length === 1 && keys[0] === "tools") {
        return { tools: arr(m.tools, `${p}.tools`).map((x, j) => toolMove(x, `${p}.tools[${j}]`)) };
      }
      if (keys.length === 2 && keys.includes("tool") && keys.includes("input"))
        return toolMove(m, p);
      return fail(
        `${p}: a move is { text } | { tool, input } | { tools: [...] } (got ${keys.join(", ")})`,
      );
    }),
  );
}

function matcher(v: unknown, path: string): Matcher {
  if (v === null || typeof v === "number" || typeof v === "boolean") return v;
  if (isStr(v)) {
    if (v.startsWith("$") && !(MATCHER_PLACEHOLDERS as readonly string[]).includes(v)) {
      fail(`${path}: unknown matcher "${v}" (allowed: ${MATCHER_PLACEHOLDERS.join(", ")})`);
    }
    return v;
  }
  if (isObj(v) && Object.keys(v).length === 1 && Array.isArray(v.$in)) return { $in: v.$in };
  return fail(
    `${path}: expected a literal, { $in: [...] } or one of ${MATCHER_PLACEHOLDERS.join(", ")}`,
  );
}

function expectation(v: unknown, path: string): Expectation {
  const e = obj(v, path, [
    "toolCalls",
    "writes",
    "escalation",
    "noWriteWithoutConsent",
    "noHallucinatedSlots",
    "status",
    "patientMessages",
    "llmCalls",
    "noForeignWrites",
  ]);
  const out: Expectation = {};
  if (e.toolCalls !== undefined) {
    const tc = obj(e.toolCalls, `${path}.toolCalls`, ["mustInclude", "mustNotInclude"]);
    out.toolCalls = {};
    if (tc.mustInclude !== undefined) {
      out.toolCalls.mustInclude = arr(tc.mustInclude, `${path}.toolCalls.mustInclude`).map(
        (c, i) => {
          const p = `${path}.toolCalls.mustInclude[${i}]`;
          const o = obj(c, p, ["name", "input"]);
          const call: ExpectedCall = { name: str(o.name, `${p}.name`) };
          if (o.input !== undefined) {
            if (!isObj(o.input)) fail(`${p}.input: expected an object of matchers`);
            call.input = Object.fromEntries(
              Object.entries(o.input).map(([k, m]) => [k, matcher(m, `${p}.input.${k}`)]),
            );
          }
          return call;
        },
      );
    }
    if (tc.mustNotInclude !== undefined) {
      out.toolCalls.mustNotInclude = arr(tc.mustNotInclude, `${path}.toolCalls.mustNotInclude`).map(
        (n, i) => str(n, `${path}.toolCalls.mustNotInclude[${i}]`),
      );
    }
  }
  if (e.writes !== undefined) {
    const w = obj(e.writes, `${path}.writes`, [
      "holds",
      "bookings",
      "calendarEvents",
      "escalations",
    ]);
    out.writes = {
      holds: optInt(w.holds, `${path}.writes.holds`),
      bookings: optInt(w.bookings, `${path}.writes.bookings`),
      calendarEvents: optInt(w.calendarEvents, `${path}.writes.calendarEvents`),
      escalations: optInt(w.escalations, `${path}.writes.escalations`),
    };
  }
  if (e.escalation !== undefined) {
    const es = obj(e.escalation, `${path}.escalation`, ["expected", "reasonIn"]);
    out.escalation = { expected: bool(es.expected, `${path}.escalation.expected`) };
    if (es.reasonIn !== undefined) {
      out.escalation.reasonIn = arr(es.reasonIn, `${path}.escalation.reasonIn`).map((r, i) =>
        str(r, `${path}.escalation.reasonIn[${i}]`),
      );
    }
  }
  out.noWriteWithoutConsent = optBool(e.noWriteWithoutConsent, `${path}.noWriteWithoutConsent`);
  out.noHallucinatedSlots = optBool(e.noHallucinatedSlots, `${path}.noHallucinatedSlots`);
  if (e.status !== undefined) {
    const s = str(e.status, `${path}.status`);
    if (!["active", "escalated", "completed"].includes(s))
      fail(`${path}.status: active | escalated | completed`);
    out.status = s as ConversationStatus;
  }
  out.patientMessages = optInt(e.patientMessages, `${path}.patientMessages`);
  out.llmCalls = optInt(e.llmCalls, `${path}.llmCalls`);
  out.noForeignWrites = optBool(e.noForeignWrites, `${path}.noForeignWrites`);
  return out;
}

/** Validate one raw JSON case. Throws CaseValidationError naming the offending field. */
export function validateCase(raw: unknown): EvalCase {
  const c = obj(raw, "case", [
    "id",
    "category",
    "title",
    "limitation",
    "seed",
    "patient",
    "turns",
    "llmScript",
    "labels",
    "expect",
    "liveExpect",
  ]);
  const id = str(c.id, "id", /^[a-z0-9][a-z0-9-]*$/);
  const category = str(c.category, "category");
  if (!(CATEGORIES as readonly string[]).includes(category)) {
    fail(`category: "${category}" is not one of ${CATEGORIES.join(", ")}`);
  }
  const title = str(c.title, "title");
  const limitation = optStr(c.limitation, "limitation");
  const sd = seed(c.seed);
  const patientObj = obj(c.patient, "patient", ["phone"]);
  const patient = { phone: phone(patientObj.phone, "patient.phone") };
  const ts = turns(c.turns, id);
  const sc = script(c.llmScript, ts.length);
  const lb = obj(c.labels, "labels", ["shouldEscalate", "escalationReason"]);
  const labels = {
    shouldEscalate: bool(lb.shouldEscalate, "labels.shouldEscalate"),
    escalationReason: optStr(lb.escalationReason, "labels.escalationReason"),
  };
  const exp = expectation(c.expect, "expect");
  exp.noWriteWithoutConsent ??= true;
  exp.noHallucinatedSlots ??= true;
  exp.noForeignWrites ??= true;
  const liveExpect =
    c.liveExpect === undefined ? undefined : expectation(c.liveExpect, "liveExpect");

  if (exp.escalation && exp.escalation.expected !== labels.shouldEscalate) {
    fail("labels.shouldEscalate disagrees with expect.escalation.expected");
  }
  if (category === "injection") {
    // A hold is temporary and never a commitment; the adversarial outcome that matters is a
    // booking (calendar event) or an escalation the case explicitly expects.
    const w = exp.writes;
    const zero = w?.bookings === 0 && w?.calendarEvents === 0;
    if (!labels.shouldEscalate && !zero) {
      fail(
        "injection case: declare labels.shouldEscalate = true or expect.writes with zero bookings/calendarEvents",
      );
    }
  }
  return {
    id,
    category: category as Category,
    title,
    limitation,
    seed: sd,
    patient,
    turns: ts,
    llmScript: sc,
    labels,
    expect: exp,
    liveExpect,
  };
}

/** Load and validate every `*.json` in `dir`; ids must equal file names and be unique. */
export function loadCases(dir: string): EvalCase[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const seen = new Set<string>();
  const cases = files.map((file) => {
    const path = join(dir, file);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new CaseValidationError(`${file}: invalid JSON (${(e as Error).message})`);
    }
    let c: EvalCase;
    try {
      c = validateCase(raw);
    } catch (e) {
      throw new CaseValidationError(`${file}: ${(e as Error).message}`);
    }
    const expected = basename(file, ".json");
    if (c.id !== expected)
      throw new CaseValidationError(`${file}: id "${c.id}" must equal the file name`);
    if (seen.has(c.id)) throw new CaseValidationError(`${file}: duplicate id "${c.id}"`);
    seen.add(c.id);
    return c;
  });
  if (cases.length === 0) throw new CaseValidationError(`${dir}: no cases found`);
  return cases.sort((a, b) => (a.id < b.id ? -1 : 1));
}
