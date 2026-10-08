import { describe, expect, it } from "vitest";
import { type EvalCase, FOREIGN_PHONE, validateCase } from "../../evals/lib/case-schema";
import type { CaseContext } from "../../evals/lib/runner";
import { compileScript, lastAvailability, lastHoldIdOf, ScriptError } from "../../evals/lib/script";
import type { LlmMessage, LlmTurnInput } from "../../src/ports/llm-port";

// T417 — a case's llmScript compiles into an LLMPort the orchestrator drives: one move per
// model call, moves grouped per inbound turn, placeholders resolved from what the model has
// actually been shown (tool_results in the history) or from the seeded context.

const ctx: CaseContext = {
  caseId: "c",
  patientPhone: "+5531900000101",
  foreignPhone: FOREIGN_PHONE,
  otherConversationHoldId: "hold-other",
  foreignBookingId: "booking-other",
};

function makeCase(llmScript: unknown[][]): EvalCase {
  return validateCase({
    id: "c",
    category: "happy_path",
    title: "t",
    seed: { now: "2026-06-15T12:00:00Z", capacity: [], consent: "opted_in" },
    patient: { phone: "+5531900000101" },
    turns: llmScript.map((_, i) => ({ text: `turn ${i}` })),
    llmScript,
    labels: { shouldEscalate: false },
    expect: {},
  });
}

const input = (messages: LlmMessage[] = []): LlmTurnInput => ({ system: "s", tools: [], messages });

const availabilityResult: LlmMessage[] = [
  { role: "user", content: [{ type: "text", text: "oi" }] },
  {
    role: "assistant",
    content: [{ type: "tool_use", id: "tu_a", name: "get_availability", input: {} }],
  },
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        toolUseId: "tu_a",
        content: JSON.stringify({
          slots: [
            { start: "2026-06-16T12:00:00.000Z", end: "x", type: "cleaning" },
            { start: "2026-06-16T12:30:00.000Z", end: "x", type: "cleaning" },
          ],
          truncated: false,
        }),
      },
    ],
  },
  { role: "assistant", content: [{ type: "tool_use", id: "tu_h", name: "hold_slot", input: {} }] },
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        toolUseId: "tu_h",
        content: JSON.stringify({ holdId: "hold-123", start: "2026-06-16T12:00:00.000Z" }),
      },
    ],
  },
];

describe("compileScript", () => {
  it("text → final turn; tool → one tool_use; tools → several tool_use blocks in one response", async () => {
    const llm = compileScript(
      makeCase([
        [
          { tool: "get_availability", input: { from: "a", to: "b", type: "cleaning" } },
          {
            tools: [
              { tool: "escalate_to_human", input: { reason: "r", context: "c" } },
              { tool: "confirm_booking", input: { hold_id: "x", patient_name: "Ana Teste" } },
            ],
          },
          { text: "pronto" },
        ],
      ]),
      ctx,
    );
    llm.beginTurn(0);
    const t1 = await llm.turn(input());
    expect(t1).toEqual({
      stopReason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tu_c_0_0_0",
          name: "get_availability",
          input: { from: "a", to: "b", type: "cleaning" },
        },
      ],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    const t2 = await llm.turn(input());
    expect(t2.stopReason).toBe("tool_use");
    expect(t2.content.map((c) => (c.type === "tool_use" ? c.name : c.type))).toEqual([
      "escalate_to_human",
      "confirm_booking",
    ]);
    expect(t2.content.map((c) => (c.type === "tool_use" ? c.id : ""))).toEqual([
      "tu_c_0_1_0",
      "tu_c_0_1_1",
    ]);
    const t3 = await llm.turn(input());
    expect(t3).toEqual({
      stopReason: "end_turn",
      content: [{ type: "text", text: "pronto" }],
      usage: expect.anything(),
    });
    expect(llm.callCount).toBe(3);
  });

  it("resolves placeholders from the history and the context", async () => {
    const llm = compileScript(
      makeCase([
        [
          { tool: "hold_slot", input: { start: "$offeredSlot[1]", type: "cleaning" } },
          {
            tool: "confirm_booking",
            input: {
              hold_id: "$lastHoldId",
              patient_name: "Ana Teste",
              nested: { other: "$otherConversationHoldId", phone: "$foreignPhone" },
            },
          },
        ],
      ]),
      ctx,
    );
    llm.beginTurn(0);
    const t1 = await llm.turn(input(availabilityResult));
    expect(t1.content[0]).toMatchObject({
      input: { start: "2026-06-16T12:30:00.000Z", type: "cleaning" },
    });
    const t2 = await llm.turn(input(availabilityResult));
    expect(t2.content[0]).toMatchObject({
      input: {
        hold_id: "hold-123",
        patient_name: "Ana Teste",
        nested: { other: "hold-other", phone: FOREIGN_PHONE },
      },
    });
  });

  it("fails loudly when a placeholder cannot be resolved at run time", async () => {
    const llm = compileScript(
      makeCase([[{ tool: "hold_slot", input: { start: "$offeredSlot[0]", type: "cleaning" } }]]),
      ctx,
    );
    llm.beginTurn(0);
    await expect(llm.turn(input())).rejects.toThrow(ScriptError);
    await expect(llm.turn(input())).rejects.toThrow(/\$offeredSlot\[0\].*no availability/);
    const llm2 = compileScript(
      makeCase([
        [{ tool: "confirm_booking", input: { hold_id: "$lastHoldId", patient_name: "Ana Teste" } }],
      ]),
      ctx,
    );
    llm2.beginTurn(0);
    await expect(llm2.turn(input())).rejects.toThrow(/\$lastHoldId.*no hold/);
    const llm3 = compileScript(
      makeCase([
        [
          {
            tool: "confirm_booking",
            input: { hold_id: "$otherConversationHoldId", patient_name: "Ana Teste" },
          },
        ],
      ]),
      {
        ...ctx,
        otherConversationHoldId: null,
      },
    );
    llm3.beginTurn(0);
    await expect(llm3.turn(input())).rejects.toThrow(/\$otherConversationHoldId.*seed/);
  });

  it("script exhaustion names the case and the turn; beginTurn selects the moves of an inbound turn", async () => {
    const llm = compileScript(makeCase([[{ text: "a" }], [{ text: "b" }, { text: "c" }]]), ctx);
    llm.beginTurn(0);
    await llm.turn(input());
    await expect(llm.turn(input())).rejects.toThrow(/case "c".*turn 1.*exhausted/);
    llm.beginTurn(1);
    expect((await llm.turn(input())).content).toEqual([{ type: "text", text: "b" }]);
    expect((await llm.turn(input())).content).toEqual([{ type: "text", text: "c" }]);
    await expect(llm.turn(input())).rejects.toThrow(/turn 2.*exhausted/);
    llm.beginTurn(5);
    await expect(llm.turn(input())).rejects.toThrow(/turn 6.*no script/);
  });
});

describe("history readers", () => {
  it("lastAvailability returns the starts of the LAST availability result; lastHoldIdOf the last hold id", () => {
    expect(lastAvailability(availabilityResult)).toEqual([
      "2026-06-16T12:00:00.000Z",
      "2026-06-16T12:30:00.000Z",
    ]);
    expect(lastHoldIdOf(availabilityResult)).toBe("hold-123");
    expect(lastAvailability([])).toEqual([]);
    expect(lastHoldIdOf([])).toBeNull();
    const errored: LlmMessage[] = [
      ...availabilityResult,
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_b", name: "get_availability", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "tu_b",
            content: "Argumentos inválidos",
            isError: true,
          },
        ],
      },
    ];
    expect(lastAvailability(errored)).toEqual([]); // the LAST result was an error → nothing offered by it
  });
});

describe("006 placeholders", () => {
  const found: LlmMessage[] = [
    { role: "user", content: [{ type: "text", text: "quero cancelar" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "tu_f", name: "find_my_booking", input: {} }],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "tu_f",
          content: JSON.stringify({ bookingId: "b-own", start: "x", label: "y", type: "cleaning" }),
        },
      ],
    },
  ];

  it("$lastBookingId is the booking find_my_booking showed; $foreignBookingId comes from the seed", async () => {
    const llm = compileScript(
      makeCase([
        [
          { tool: "cancel_booking", input: { booking_id: "$lastBookingId" } },
          { tool: "cancel_booking", input: { booking_id: "$foreignBookingId" } },
        ],
      ]),
      ctx,
    );
    llm.beginTurn(0);
    expect((await llm.turn(input(found))).content[0]).toMatchObject({
      input: { booking_id: "b-own" },
    });
    expect((await llm.turn(input(found))).content[0]).toMatchObject({
      input: { booking_id: "booking-other" },
    });
  });

  it("a reschedule result (it carries previousBookingId) is not mistaken for the shown booking", async () => {
    const afterReschedule: LlmMessage[] = [
      ...found,
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "tu_r",
            content: JSON.stringify({ bookingId: "b-new", previousBookingId: "b-own" }),
          },
        ],
      },
    ];
    const llm = compileScript(
      makeCase([[{ tool: "cancel_booking", input: { booking_id: "$lastBookingId" } }]]),
      ctx,
    );
    llm.beginTurn(0);
    expect((await llm.turn(input(afterReschedule))).content[0]).toMatchObject({
      input: { booking_id: "b-own" },
    });
  });

  it("fails loudly when no booking was shown yet or the seed has no foreign booking", async () => {
    const llm = compileScript(
      makeCase([[{ tool: "cancel_booking", input: { booking_id: "$lastBookingId" } }]]),
      ctx,
    );
    llm.beginTurn(0);
    await expect(llm.turn(input())).rejects.toBeInstanceOf(ScriptError);
    const noForeign = compileScript(
      makeCase([[{ tool: "cancel_booking", input: { booking_id: "$foreignBookingId" } }]]),
      { ...ctx, foreignBookingId: null },
    );
    noForeign.beginTurn(0);
    await expect(noForeign.turn(input())).rejects.toThrow(/foreignBookingId/);
  });
});
