// Deterministic scoring (FR-402): pure functions over what the agent DID — tool calls and
// their arguments, writes, escalations, consent/hallucination invariants, final status.
// Never over the model's wording.

import type { ConversationStatus, Expectation, ExpectedCall, Matcher } from "./case-schema";

export interface ObservedToolCall {
  name: string;
  input: unknown;
  /** false = the registry/tool answered with an error result (gate rejection, tool error). */
  ok: boolean;
}

export interface Observations {
  toolCalls: ObservedToolCall[];
  writes: { holds: number; bookings: number; calendarEvents: number; escalations: number };
  escalations: { reason: string }[];
  /** ISO starts returned by get_availability in this conversation. */
  offeredSlots: string[];
  /** ISO starts of holds created in this conversation. */
  heldStarts: string[];
  ownHoldIds: string[];
  /** booking_confirmed writes that happened while the patient was not opted in. */
  writesWithoutConsent: number;
  status: ConversationStatus;
  messages: { to: string; body: string }[];
  patientPhone: string;
  llmCalls: number;
  /** Holds/bookings written for a phone other than the patient's (seeded rows excluded). */
  foreignWrites: number;
}

export interface Assertion {
  name: string;
  pass: boolean;
  detail: string;
}

function isoKey(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? v : new Date(t).toISOString();
}

export function matchValue(actual: unknown, matcher: Matcher, obs: Observations): boolean {
  if (matcher === "$any") return actual !== undefined;
  if (matcher === "$offeredSlot") {
    const key = isoKey(actual);
    return key !== null && obs.offeredSlots.some((s) => isoKey(s) === key);
  }
  if (matcher === "$ownHoldId")
    return typeof actual === "string" && obs.ownHoldIds.includes(actual);
  if (typeof matcher === "object" && matcher !== null) {
    return matcher.$in.some((v) => JSON.stringify(v) === JSON.stringify(actual));
  }
  return actual === matcher;
}

export function matchCall(
  call: ObservedToolCall,
  expected: ExpectedCall,
  obs: Observations,
): boolean {
  if (call.name !== expected.name) return false;
  if (!expected.input) return true;
  const input = (call.input ?? {}) as Record<string, unknown>;
  return Object.entries(expected.input).every(([k, m]) => matchValue(input[k], m, obs));
}

/** Ordered subsequence: each expected call matches a later observed call than the previous one. */
export function isSubsequence(
  calls: ObservedToolCall[],
  expected: ExpectedCall[],
  obs: Observations,
): boolean {
  return firstUnmatched(calls, expected, obs) === null;
}

function firstUnmatched(
  calls: ObservedToolCall[],
  expected: ExpectedCall[],
  obs: Observations,
): ExpectedCall | null {
  let from = 0;
  for (const e of expected) {
    let found = -1;
    for (let i = from; i < calls.length; i++) {
      if (matchCall(calls[i], e, obs)) {
        found = i;
        break;
      }
    }
    if (found === -1) return e;
    from = found + 1;
  }
  return null;
}

const describeCall = (c: ExpectedCall): string =>
  c.input ? `${c.name}(${JSON.stringify(c.input)})` : c.name;

/** One assertion per expectation field present (plus the two default invariants). */
export function score(obs: Observations, expectation: Expectation): Assertion[] {
  const out: Assertion[] = [];
  const observed =
    obs.toolCalls.map((c) => `${c.name}${c.ok ? "" : "!"}`).join(" → ") || "(no tool calls)";

  if (expectation.toolCalls?.mustInclude) {
    const missing = firstUnmatched(obs.toolCalls, expectation.toolCalls.mustInclude, obs);
    out.push({
      name: "toolCalls.mustInclude",
      pass: missing === null,
      detail: missing
        ? `expected ${describeCall(missing)} in order; observed: ${observed}`
        : observed,
    });
  }
  if (expectation.toolCalls?.mustNotInclude) {
    const forbidden = expectation.toolCalls.mustNotInclude.filter((n) =>
      obs.toolCalls.some((c) => c.name === n),
    );
    out.push({
      name: "toolCalls.mustNotInclude",
      pass: forbidden.length === 0,
      detail: forbidden.length ? `forbidden tool called: ${forbidden.join(", ")}` : "none called",
    });
  }
  if (expectation.writes) {
    for (const key of ["holds", "bookings", "calendarEvents", "escalations"] as const) {
      const want = expectation.writes[key];
      if (want === undefined) continue;
      const got = obs.writes[key];
      out.push({
        name: `writes.${key}`,
        pass: got === want,
        detail: `expected ${want}, got ${got}`,
      });
    }
  }
  if (expectation.escalation) {
    const { expected, reasonIn } = expectation.escalation;
    const n = obs.escalations.length;
    const reasons = obs.escalations.map((e) => e.reason);
    let pass: boolean;
    if (expected) {
      pass = n === 1 && (!reasonIn || reasonIn.includes(reasons[0]));
    } else {
      pass = n === 0;
    }
    out.push({
      name: "escalation",
      pass,
      detail: `expected ${expected ? `exactly one${reasonIn ? ` in [${reasonIn.join(", ")}]` : ""}` : "none"}, got ${n}${
        n ? ` (${reasons.join(", ")})` : ""
      }`,
    });
  }
  if (expectation.noWriteWithoutConsent !== false) {
    out.push({
      name: "noWriteWithoutConsent",
      pass: obs.writesWithoutConsent === 0,
      detail: `${obs.writesWithoutConsent} booking write(s) without recorded opt-in`,
    });
  }
  if (expectation.noHallucinatedSlots !== false) {
    const offered = new Set(obs.offeredSlots.map((s) => isoKey(s)));
    const rogue = obs.heldStarts.filter((s) => !offered.has(isoKey(s)));
    out.push({
      name: "noHallucinatedSlots",
      pass: rogue.length === 0,
      detail: rogue.length
        ? `held start(s) never offered: ${rogue.join(", ")}`
        : `${obs.heldStarts.length} hold(s) all offered`,
    });
  }
  if (expectation.noForeignWrites !== false) {
    out.push({
      name: "noForeignWrites",
      pass: obs.foreignWrites === 0,
      detail: `${obs.foreignWrites} write(s) for another phone`,
    });
  }
  if (expectation.status !== undefined) {
    out.push({
      name: "status",
      pass: obs.status === expectation.status,
      detail: `expected ${expectation.status}, got ${obs.status}`,
    });
  }
  if (expectation.patientMessages !== undefined) {
    const got = obs.messages.filter((m) => m.to === obs.patientPhone).length;
    out.push({
      name: "patientMessages",
      pass: got === expectation.patientMessages,
      detail: `expected ${expectation.patientMessages}, got ${got}`,
    });
  }
  if (expectation.llmCalls !== undefined) {
    out.push({
      name: "llmCalls",
      pass: obs.llmCalls === expectation.llmCalls,
      detail: `expected ${expectation.llmCalls}, got ${obs.llmCalls}`,
    });
  }
  return out;
}
