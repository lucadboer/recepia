import { describe, expect, it } from "vitest";
import { FakeLLM, finalTurn, toolUse, toolUseTurn } from "../../src/adapters/fakes/fake-llm";
import type { LlmTurnInput } from "../../src/ports/llm-port";

const input: LlmTurnInput = { system: "s", tools: [], messages: [] };

describe("FakeLLM", () => {
  it("returns scripted turns in order and records inputs", async () => {
    const llm = new FakeLLM([
      toolUseTurn(toolUse("getAvailability", { type: "cleaning" })),
      finalTurn("pronto"),
    ]);
    const t1 = await llm.turn(input);
    expect(t1.stopReason).toBe("tool_use");
    const t2 = await llm.turn(input);
    expect(t2.stopReason).toBe("end_turn");
    expect(llm.callCount).toBe(2);
    expect(llm.receivedInputs[0]).toBe(input);
  });

  it("supports reactive turns that branch on the input", async () => {
    const llm = new FakeLLM([
      (inp) =>
        inp.messages.length === 0 ? toolUseTurn(toolUse("getAvailability", {})) : finalTurn("done"),
    ]);
    const t = await llm.turn({ ...input, messages: [] });
    expect(t.stopReason).toBe("tool_use");
  });

  it("throws when the script is exhausted", async () => {
    const llm = new FakeLLM([finalTurn("only one")]);
    await llm.turn(input);
    await expect(llm.turn(input)).rejects.toThrow(/script exhausted/);
  });
});
