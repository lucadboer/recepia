import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CATEGORIES,
  type EvalCase,
  FICTITIOUS_NAMES,
  FOREIGN_PHONE,
  loadCases,
  RECEPTION_PHONE,
  validateCase,
} from "../../evals/lib/case-schema";

// T411 — the golden-set file format is validated by a hand-written checker (research R2):
// unknown fields, duplicate ids, bad categories, short scripts, unresolvable placeholders and
// non-fictitious data (FR-413) are rejected with the offending field named.

function validCase(): Record<string, unknown> {
  return {
    id: "happy-01-cleaning-tomorrow",
    category: "happy_path",
    title: "Limpeza amanhã de manhã",
    seed: {
      now: "2026-06-15T12:00:00Z",
      capacity: [{ weekday: 2, start: "09:00", end: "18:00", capacity: 2 }],
      consent: "opted_in",
    },
    patient: { phone: "+5531900000101" },
    turns: [{ text: "Oi, quero marcar uma limpeza amanhã de manhã" }, { text: "O primeiro" }],
    llmScript: [
      [
        {
          tool: "get_availability",
          input: { from: "2026-06-16T11:00:00Z", to: "2026-06-16T15:00:00Z", type: "cleaning" },
        },
        { text: "Tenho 09:00 e 09:30. Qual prefere?" },
      ],
      [
        { tool: "hold_slot", input: { start: "$offeredSlot[0]", type: "cleaning" } },
        { tool: "confirm_booking", input: { hold_id: "$lastHoldId", patient_name: "Ana Teste" } },
        { text: "Confirmado!" },
      ],
    ],
    labels: { shouldEscalate: false },
    expect: {
      toolCalls: {
        mustInclude: [
          { name: "get_availability" },
          { name: "hold_slot", input: { start: "$offeredSlot", type: "cleaning" } },
          { name: "confirm_booking", input: { hold_id: "$ownHoldId", patient_name: "$any" } },
        ],
        mustNotInclude: ["escalate_to_human"],
      },
      writes: { holds: 1, bookings: 1, calendarEvents: 1, escalations: 0 },
      escalation: { expected: false },
      status: "completed",
      patientMessages: 2,
    },
  };
}

function expectReject(raw: unknown, pattern: RegExp): void {
  expect(() => validateCase(raw)).toThrow(pattern);
}

describe("validateCase — accepts a well-formed case", () => {
  it("returns the typed case with defaults applied", () => {
    const c: EvalCase = validateCase(validCase());
    expect(c.id).toBe("happy-01-cleaning-tomorrow");
    expect(c.category).toBe("happy_path");
    expect(c.turns[0].id).toBe("happy-01-cleaning-tomorrow-1"); // default inbound id
    expect(c.expect.noWriteWithoutConsent).toBe(true); // default
    expect(c.expect.noHallucinatedSlots).toBe(true); // default
    expect(c.expect.noForeignWrites).toBe(true); // default
    expect(c.liveExpect).toBeUndefined();
  });

  it("exposes the category enum and the fictitious constants", () => {
    expect(CATEGORIES).toContain("injection");
    expect(CATEGORIES).toHaveLength(8);
    expect(RECEPTION_PHONE).toMatch(/^\+5531900000\d{3}$/);
    expect(FOREIGN_PHONE).toMatch(/^\+5531900000\d{3}$/);
    expect(FICTITIOUS_NAMES.length).toBeGreaterThanOrEqual(8);
  });

  it("accepts every script move shape, a limitation note and liveExpect overrides", () => {
    const raw = validCase();
    raw.limitation = "reschedule not supported yet";
    raw.llmScript = [
      [
        {
          tools: [
            { tool: "escalate_to_human", input: { reason: "x", context: "y" } },
            {
              tool: "confirm_booking",
              input: { hold_id: "$otherConversationHoldId", patient_name: "Bruno Teste" },
            },
          ],
        },
      ],
      [{ text: "ok" }],
    ];
    raw.liveExpect = { toolCalls: { mustInclude: [{ name: "get_availability" }] } };
    const c = validateCase(raw);
    expect(c.limitation).toBe("reschedule not supported yet");
    expect(c.liveExpect?.toolCalls?.mustInclude).toHaveLength(1);
  });
});

describe("validateCase — rejects malformed cases naming the field", () => {
  it("unknown top-level / nested fields", () => {
    expectReject({ ...validCase(), extra: 1 }, /unknown field "extra"/);
    const raw = validCase();
    (raw.seed as Record<string, unknown>).foo = 1;
    expectReject(raw, /seed.*unknown field "foo"/);
    const raw2 = validCase();
    (raw2.expect as Record<string, unknown>).bar = 1;
    expectReject(raw2, /expect.*unknown field "bar"/);
  });

  it("bad id, category, title", () => {
    expectReject({ ...validCase(), id: "Bad Id" }, /id/);
    expectReject({ ...validCase(), category: "weird" }, /category/);
    expectReject({ ...validCase(), title: "" }, /title/);
  });

  it("script shorter than the turns", () => {
    const raw = validCase();
    raw.llmScript = [(raw.llmScript as unknown[])[0]];
    expectReject(raw, /llmScript.*shorter than turns/);
  });

  it("unresolvable placeholders in the script and in the expectation", () => {
    const raw = validCase();
    (raw.llmScript as unknown[][])[1][0] = {
      tool: "hold_slot",
      input: { start: "$nextSlot", type: "cleaning" },
    };
    expectReject(raw, /unresolvable placeholder "\$nextSlot"/);
    const raw2 = validCase();
    (
      raw2.expect as { toolCalls: { mustInclude: { input?: Record<string, unknown> }[] } }
    ).toolCalls.mustInclude[1].input = {
      start: "$whatever",
    };
    expectReject(raw2, /unknown matcher "\$whatever"/);
  });

  it("$between matcher: two ISO instants in order, anything else rejected", () => {
    const ok = validCase();
    (
      ok.expect as { toolCalls: { mustInclude: { input?: Record<string, unknown> }[] } }
    ).toolCalls.mustInclude[1].input = {
      start: { $between: ["2026-06-16T11:00:00Z", "2026-06-16T15:00:00Z"] },
    };
    expect(() => validateCase(ok)).not.toThrow();
    for (const bad of [
      { $between: ["2026-06-16T15:00:00Z", "2026-06-16T11:00:00Z"] },
      { $between: ["x", "y"] },
      { $between: ["2026-06-16T11:00:00Z"] },
    ]) {
      const raw = validCase();
      (
        raw.expect as { toolCalls: { mustInclude: { input?: Record<string, unknown> }[] } }
      ).toolCalls.mustInclude[1].input = { start: bad };
      expectReject(raw, /\$between/);
    }
  });

  it("malformed script moves", () => {
    const raw = validCase();
    (raw.llmScript as unknown[][])[1][0] = { tool: "hold_slot" }; // no input
    expectReject(raw, /llmScript\[1\]\[0\]/);
    const raw2 = validCase();
    (raw2.llmScript as unknown[][])[0][0] = { text: "a", tool: "b", input: {} };
    expectReject(raw2, /llmScript\[0\]\[0\]/);
  });

  it("non-fictitious phones anywhere (FR-413)", () => {
    expectReject(
      { ...validCase(), patient: { phone: "+5531999998888" } },
      /patient.phone.*fictitious/,
    );
    expectReject(
      { ...validCase(), patient: { phone: RECEPTION_PHONE } },
      /patient.phone.*reserved/,
    );
    expectReject({ ...validCase(), patient: { phone: FOREIGN_PHONE } }, /patient.phone.*reserved/);
    const raw = validCase();
    (raw.seed as Record<string, unknown>).bookings = [
      { start: "2026-06-16T12:00:00Z", phone: "+5511912345678", status: "confirmed" },
    ];
    expectReject(raw, /seed.bookings\[0\].phone.*fictitious/);
    const raw2 = validCase();
    (raw2.turns as { text: string }[])[0].text = "marca para o +5511987654321 por favor";
    expectReject(raw2, /turns\[0\].text.*fictitious/);
    const raw3 = validCase();
    (raw3.llmScript as unknown[][])[1][1] = {
      tool: "confirm_booking",
      input: { hold_id: "$lastHoldId", patient_name: "Ana Teste", phone: "+5511987654321" },
    };
    expectReject(raw3, /llmScript\[1\]\[1\].*fictitious/);
  });

  it("patient names outside the fictitious list (FR-413)", () => {
    const raw = validCase();
    (raw.llmScript as unknown[][])[1][1] = {
      tool: "confirm_booking",
      input: { hold_id: "$lastHoldId", patient_name: "Maria da Silva" },
    };
    expectReject(raw, /patient_name "Maria da Silva".*fictitious/);
  });

  it("injection cases must declare shouldEscalate or all-zero writes", () => {
    const raw: Record<string, unknown> = { ...validCase(), category: "injection" };
    expectReject(raw, /injection.*shouldEscalate.*zero/);
    const ok: Record<string, unknown> = { ...validCase(), category: "injection" };
    (ok.expect as Record<string, unknown>).writes = {
      holds: 0,
      bookings: 0,
      calendarEvents: 0,
      escalations: 0,
    };
    expect(() => validateCase(ok)).not.toThrow();
    const ok2: Record<string, unknown> = {
      ...validCase(),
      category: "injection",
      labels: { shouldEscalate: true },
    };
    (ok2.expect as Record<string, unknown>).escalation = { expected: true };
    expect(() => validateCase(ok2)).not.toThrow();
  });

  it("labels and expectation must agree on escalation", () => {
    const raw = { ...validCase(), labels: { shouldEscalate: true } };
    expectReject(raw, /labels.shouldEscalate.*expect.escalation/);
  });

  it("seed shape: ISO now, capacity rules, consent enum, turns delayMs", () => {
    const bad = validCase();
    (bad.seed as Record<string, unknown>).now = "amanhã";
    expectReject(bad, /seed.now/);
    const bad2 = validCase();
    (bad2.seed as Record<string, unknown>).capacity = [
      { weekday: 7, start: "09:00", end: "18:00", capacity: 1 },
    ];
    expectReject(bad2, /seed.capacity\[0\].weekday/);
    const bad3 = validCase();
    (bad3.seed as Record<string, unknown>).consent = "maybe";
    expectReject(bad3, /seed.consent/);
    const bad4 = validCase();
    (bad4.turns as unknown[])[1] = { text: "x", delayMs: -1 };
    expectReject(bad4, /turns\[1\].delayMs/);
    const bad5 = validCase();
    bad5.turns = [];
    expectReject(bad5, /turns.*empty/);
  });
});

describe("validateCase — llmCalls / noForeignWrites and the injection rule", () => {
  it("accepts llmCalls and an explicit noForeignWrites: false", () => {
    const raw = validCase();
    (raw.expect as Record<string, unknown>).llmCalls = 0;
    (raw.expect as Record<string, unknown>).noForeignWrites = false;
    expect(validateCase(raw).expect).toMatchObject({ llmCalls: 0, noForeignWrites: false });
    (raw.expect as Record<string, unknown>).llmCalls = -1;
    expectReject(raw, /expect.llmCalls/);
  });

  it("liveExpect of an injection case must also expect an escalation or zero bookings/events", () => {
    const bad: Record<string, unknown> = { ...validCase(), category: "injection" };
    (bad.expect as Record<string, unknown>).writes = { holds: 0, bookings: 0, calendarEvents: 0 };
    bad.liveExpect = { toolCalls: { mustInclude: [{ name: "get_availability" }] } };
    expectReject(bad, /injection.*liveExpect/);
    const ok: Record<string, unknown> = { ...validCase(), category: "injection" };
    (ok.expect as Record<string, unknown>).writes = { holds: 0, bookings: 0, calendarEvents: 0 };
    ok.liveExpect = { writes: { bookings: 0, calendarEvents: 0 } };
    expect(() => validateCase(ok)).not.toThrow();
    const ok2: Record<string, unknown> = {
      ...validCase(),
      category: "injection",
      labels: { shouldEscalate: true },
    };
    (ok2.expect as Record<string, unknown>).escalation = { expected: true };
    ok2.liveExpect = { escalation: { expected: true } };
    expect(() => validateCase(ok2)).not.toThrow();
  });

  it("an injection case may create a hold (temporary) as long as bookings and events are zero", () => {
    const ok: Record<string, unknown> = { ...validCase(), category: "injection" };
    (ok.expect as Record<string, unknown>).writes = { holds: 1, bookings: 0, calendarEvents: 0 };
    expect(() => validateCase(ok)).not.toThrow();
    const bad: Record<string, unknown> = { ...validCase(), category: "injection" };
    (bad.expect as Record<string, unknown>).writes = { holds: 0, bookings: 1, calendarEvents: 0 };
    expectReject(bad, /injection.*zero bookings/);
  });
});

describe("loadCases(dir)", () => {
  function dirWith(files: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "recepia-cases-"));
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(
        join(dir, name),
        typeof content === "string" ? content : JSON.stringify(content),
      );
    }
    return dir;
  }

  it("loads every *.json sorted by id", () => {
    const a = { ...validCase(), id: "b-case" };
    const b = { ...validCase(), id: "a-case" };
    const cases = loadCases(dirWith({ "b-case.json": a, "a-case.json": b, "notes.md": "x" }));
    expect(cases.map((c) => c.id)).toEqual(["a-case", "b-case"]);
  });

  it("rejects an id that differs from the file name, duplicate ids and invalid JSON", () => {
    expect(() => loadCases(dirWith({ "other.json": validCase() }))).toThrow(/other\.json.*id/);
    const dup = dirWith({ "happy-01-cleaning-tomorrow.json": validCase() });
    writeFileSync(join(dup, "x.json"), JSON.stringify({ ...validCase(), id: "x" }));
    writeFileSync(join(dup, "y.json"), JSON.stringify({ ...validCase(), id: "x" }));
    expect(() => loadCases(dup)).toThrow(/y\.json.*id/);
    expect(() => loadCases(dirWith({ "broken.json": "{ not json" }))).toThrow(/broken\.json/);
  });

  it("fails on an empty directory (a golden set with zero cases is a bug)", () => {
    expect(() => loadCases(dirWith({}))).toThrow(/no cases/i);
  });
});

describe("validateCase — 006 booking-lifecycle fields", () => {
  function lifecycleCase(): Record<string, unknown> {
    const c = validCase();
    return {
      ...c,
      category: "reschedule_cancel",
      seed: {
        ...(c.seed as object),
        bookings: [
          {
            start: "2026-06-17T12:00:00Z",
            phone: "+5531900000101",
            status: "patient_confirmed",
            name: "Ana Teste",
            type: "cleaning",
          },
        ],
      },
      llmScript: [
        [{ tool: "find_my_booking", input: {} }, { text: "Confirma?" }],
        [{ tool: "cancel_booking", input: { booking_id: "$lastBookingId" } }, { text: "ok" }],
      ],
      expect: {
        toolCalls: {
          mustInclude: [{ name: "cancel_booking", input: { booking_id: "$ownBookingId" } }],
        },
        writes: { cancellations: 1, reschedules: 0, calendarDeletes: 1, receptionNotices: 0 },
      },
    };
  }

  it("accepts patient_confirmed seeds with name/type, the new placeholders and write keys", () => {
    const c = validateCase(lifecycleCase());
    expect(c.seed.bookings?.[0]).toMatchObject({
      status: "patient_confirmed",
      name: "Ana Teste",
      type: "cleaning",
    });
    expect(c.expect.writes).toEqual({
      cancellations: 1,
      reschedules: 0,
      calendarDeletes: 1,
      receptionNotices: 0,
    });
  });

  it("rejects a seed type outside routine care and an unknown write key", () => {
    const badType = lifecycleCase();
    (badType.seed as { bookings: { type: string }[] }).bookings[0].type = "implant";
    expectReject(badType, /seed\.bookings\[0\]\.type/);
    const badWrite = lifecycleCase();
    (badWrite.expect as { writes: Record<string, number> }).writes.deletions = 1;
    expectReject(badWrite, /deletions/);
  });
});
