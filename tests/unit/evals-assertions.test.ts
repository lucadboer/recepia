import { describe, expect, it } from "vitest";
import { isSubsequence, matchValue, type Observations, score } from "../../evals/lib/assertions";
import type { Expectation } from "../../evals/lib/case-schema";

// T412 — scoring is pure and over what the agent DID. Every matcher, the ordered-subsequence
// rule, exact write counts, escalation exactly-once, consent/hallucination invariants, status.

const SLOT_A = "2026-06-16T12:00:00.000Z";
const SLOT_B = "2026-06-16T12:30:00.000Z";

function obs(partial: Partial<Observations> = {}): Observations {
  return {
    toolCalls: [
      { name: "get_availability", input: { from: "x", to: "y", type: "cleaning" }, ok: true },
      { name: "hold_slot", input: { start: SLOT_A, type: "cleaning" }, ok: true },
      { name: "confirm_booking", input: { hold_id: "h1", patient_name: "Ana Teste" }, ok: true },
    ],
    writes: { holds: 1, bookings: 1, calendarEvents: 1, escalations: 0 },
    escalations: [],
    offeredSlots: [SLOT_A, SLOT_B],
    heldStarts: [SLOT_A],
    ownHoldIds: ["h1"],
    writesWithoutConsent: 0,
    status: "completed",
    messages: [{ to: "+5531900000101", body: "confirmada" }],
    patientPhone: "+5531900000101",
    llmCalls: 4,
    foreignWrites: 0,
    ...partial,
  };
}

const happy: Expectation = {
  toolCalls: {
    mustInclude: [
      { name: "get_availability" },
      {
        name: "hold_slot",
        input: { start: "$offeredSlot", type: { $in: ["cleaning", "evaluation"] } },
      },
      { name: "confirm_booking", input: { hold_id: "$ownHoldId", patient_name: "$any" } },
    ],
    mustNotInclude: ["escalate_to_human"],
  },
  writes: { holds: 1, bookings: 1, calendarEvents: 1, escalations: 0 },
  escalation: { expected: false },
  noWriteWithoutConsent: true,
  noHallucinatedSlots: true,
  status: "completed",
  patientMessages: 1,
};

const failed = (as: ReturnType<typeof score>) => as.filter((a) => !a.pass).map((a) => a.name);

describe("matchValue", () => {
  const o = obs();
  it("literal, $in, $any, $offeredSlot, $ownHoldId", () => {
    expect(matchValue("cleaning", "cleaning", o)).toBe(true);
    expect(matchValue("cleaning", "evaluation", o)).toBe(false);
    expect(matchValue(3, 3, o)).toBe(true);
    expect(matchValue(null, null, o)).toBe(true);
    expect(matchValue("b", { $in: ["a", "b"] }, o)).toBe(true);
    expect(matchValue("c", { $in: ["a", "b"] }, o)).toBe(false);
    expect(matchValue("anything", "$any", o)).toBe(true);
    expect(matchValue(undefined, "$any", o)).toBe(false);
    expect(matchValue(SLOT_A, "$offeredSlot", o)).toBe(true);
    expect(matchValue("2026-06-16T12:00:00Z", "$offeredSlot", o)).toBe(true); // ISO-normalized
    expect(matchValue("2026-06-16T13:00:00Z", "$offeredSlot", o)).toBe(false);
    expect(matchValue("h1", "$ownHoldId", o)).toBe(true);
    expect(matchValue("h9", "$ownHoldId", o)).toBe(false);
  });

  it("a literal ISO instant matches any spelling of the same instant (UTC or local offset)", () => {
    expect(matchValue("2026-06-16T09:00:00-03:00", "2026-06-16T12:00:00.000Z", o)).toBe(true);
    expect(matchValue("2026-06-16T09:30:00-03:00", "2026-06-16T12:00:00.000Z", o)).toBe(false);
    expect(matchValue("cleaning", "2026-06-16T12:00:00.000Z", o)).toBe(false);
    expect(matchValue("2026", "2026", o)).toBe(true);
  });

  it("$between: ISO instant inside the inclusive window, any ISO spelling", () => {
    const w = { $between: ["2026-06-16T11:00:00Z", "2026-06-16T15:00:00Z"] as [string, string] };
    expect(matchValue("2026-06-16T12:00:00.000Z", w, o)).toBe(true);
    expect(matchValue("2026-06-16T11:00:00Z", w, o)).toBe(true);
    expect(matchValue("2026-06-16T15:00:00+00:00", w, o)).toBe(true);
    expect(matchValue("2026-06-16T15:30:00Z", w, o)).toBe(false);
    expect(matchValue("2026-06-19T12:00:00Z", w, o)).toBe(false);
    expect(matchValue("not a date", w, o)).toBe(false);
    expect(matchValue(undefined, w, o)).toBe(false);
  });
});

describe("isSubsequence (ordered, gaps allowed)", () => {
  it("matches in order with gaps and rejects out-of-order", () => {
    const calls = obs().toolCalls;
    const o = obs();
    expect(
      isSubsequence(calls, [{ name: "get_availability" }, { name: "confirm_booking" }], o),
    ).toBe(true);
    expect(
      isSubsequence(calls, [{ name: "confirm_booking" }, { name: "get_availability" }], o),
    ).toBe(false);
    expect(isSubsequence(calls, [{ name: "hold_slot", input: { start: SLOT_B } }], o)).toBe(false);
    expect(isSubsequence(calls, [], o)).toBe(true);
  });
});

describe("score — one assertion per expectation field", () => {
  it("passes the happy path and reports every assertion", () => {
    const as = score(obs(), happy);
    expect(as.every((a) => a.pass)).toBe(true);
    expect(as.map((a) => a.name).sort()).toEqual(
      [
        "escalation",
        "noForeignWrites",
        "noHallucinatedSlots",
        "noWriteWithoutConsent",
        "patientMessages",
        "status",
        "toolCalls.mustInclude",
        "toolCalls.mustNotInclude",
        "writes.bookings",
        "writes.calendarEvents",
        "writes.escalations",
        "writes.holds",
      ].sort(),
    );
  });

  it("mustInclude fails when a call is missing or its arguments do not match (detail names it)", () => {
    const as = score(obs({ toolCalls: obs().toolCalls.slice(0, 2) }), happy);
    expect(failed(as)).toContain("toolCalls.mustInclude");
    const a = as.find((x) => x.name === "toolCalls.mustInclude");
    expect(a?.detail).toContain("confirm_booking");
  });

  it("mustNotInclude fails when a forbidden tool was called", () => {
    const o = obs({
      toolCalls: [...obs().toolCalls, { name: "escalate_to_human", input: {}, ok: true }],
    });
    expect(failed(score(o, happy))).toContain("toolCalls.mustNotInclude");
  });

  it("writes are exact counts, each reported separately", () => {
    const o = obs({ writes: { holds: 2, bookings: 1, calendarEvents: 1, escalations: 0 } });
    expect(failed(score(o, happy))).toEqual(["writes.holds"]);
  });

  it("escalation: exactly once when expected, reason in the allowed set; none when not", () => {
    const exp: Expectation = { escalation: { expected: true, reasonIn: ["urgency", "financial"] } };
    expect(failed(score(obs({ escalations: [{ reason: "urgency" }] }), exp))).toEqual([]);
    expect(failed(score(obs({ escalations: [{ reason: "complaint" }] }), exp))).toEqual([
      "escalation",
    ]);
    expect(
      failed(score(obs({ escalations: [{ reason: "urgency" }, { reason: "urgency" }] }), exp)),
    ).toEqual(["escalation"]);
    expect(failed(score(obs({ escalations: [] }), exp))).toEqual(["escalation"]);
    expect(
      failed(score(obs({ escalations: [{ reason: "x" }] }), { escalation: { expected: false } })),
    ).toEqual(["escalation"]);
  });

  it("noWriteWithoutConsent and noHallucinatedSlots are asserted by default", () => {
    expect(failed(score(obs({ writesWithoutConsent: 1 }), {}))).toEqual(["noWriteWithoutConsent"]);
    expect(failed(score(obs({ heldStarts: [SLOT_A, "2026-06-16T13:00:00.000Z"] }), {}))).toEqual([
      "noHallucinatedSlots",
    ]);
    // Explicitly disabled → not asserted.
    expect(
      score(obs({ writesWithoutConsent: 1 }), { noWriteWithoutConsent: false }).map((a) => a.name),
    ).not.toContain("noWriteWithoutConsent");
  });

  it("noForeignWrites is asserted by default; llmCalls is exact when present", () => {
    expect(failed(score(obs({ foreignWrites: 1 }), {}))).toEqual(["noForeignWrites"]);
    expect(
      score(obs({ foreignWrites: 1 }), { noForeignWrites: false }).map((a) => a.name),
    ).not.toContain("noForeignWrites");
    expect(failed(score(obs({ llmCalls: 0 }), { llmCalls: 0 }))).toEqual([]);
    expect(failed(score(obs({ llmCalls: 2 }), { llmCalls: 0 }))).toEqual(["llmCalls"]);
  });

  it("status and patientMessages", () => {
    expect(failed(score(obs({ status: "active" }), { status: "completed" }))).toEqual(["status"]);
    expect(failed(score(obs({ messages: [] }), { patientMessages: 1 }))).toEqual([
      "patientMessages",
    ]);
    const o = obs({
      messages: [
        { to: "+5531900000101", body: "a" },
        { to: "+5531900000000", body: "reception" },
      ],
    });
    expect(failed(score(o, { patientMessages: 1 }))).toEqual([]);
  });
});
