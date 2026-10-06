import { describe, expect, it } from "vitest";
import {
  appendMessage,
  appendUserText,
  boundState,
  emptyState,
  markProcessed,
  pruneOfferedSlots,
  recordHold,
  recordOfferedSlots,
  trimHistory,
} from "../../src/agent/conversation";
import type { ConversationState } from "../../src/agent/types";
import {
  ACTIVE_HOLDS_MAX,
  HISTORY_MAX_MESSAGES,
  OFFERED_SLOTS_MAX,
  PROCESSED_IDS_MAX,
} from "../../src/config";
import type { LlmMessage } from "../../src/ports/llm-port";

const NOW = new Date("2026-06-15T12:00:00Z");

/** One inbound turn as the orchestrator records it: user text → tool_use → tool_result → final text. */
function turn(n: number): LlmMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: `msg ${n}` }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: `tu_${n}`, name: "get_availability", input: {} }],
    },
    { role: "user", content: [{ type: "tool_result", toolUseId: `tu_${n}`, content: "{}" }] },
    { role: "assistant", content: [{ type: "text", text: `reply ${n}` }] },
  ];
}

function withHistory(history: LlmMessage[]): ConversationState {
  return history.reduce((s, m) => appendMessage(s, m, NOW), emptyState("+55a", NOW));
}

/** Every assistant tool_use must be answered by a tool_result in the very next message (Anthropic rule). */
function pairsIntact(history: LlmMessage[]): boolean {
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    const uses = m.content.filter((c) => c.type === "tool_use");
    if (m.role === "assistant" && uses.length > 0) {
      const next = history[i + 1];
      if (next?.role !== "user") return false;
      const resultIds = new Set(
        next.content.filter((c) => c.type === "tool_result").map((c) => c.toolUseId),
      );
      for (const u of uses) if (u.type === "tool_use" && !resultIds.has(u.id)) return false;
    }
  }
  return true;
}

describe("trimHistory — bounded transcript, turn-boundary safe (T239)", () => {
  it("leaves a history within the cap untouched (same reference)", () => {
    const s = withHistory([...turn(1), ...turn(2)]);
    expect(trimHistory(s)).toBe(s);
  });

  it("trims a long history to at most HISTORY_MAX_MESSAGES, starting at a user text message", () => {
    const long = Array.from({ length: 15 }, (_, i) => turn(i + 1)).flat(); // 60 messages
    const s = withHistory(long);
    const t = trimHistory(s);
    expect(t.history.length).toBeLessThanOrEqual(HISTORY_MAX_MESSAGES);
    expect(t.history.length).toBeGreaterThan(0);
    expect(t.history[0].role).toBe("user");
    expect(t.history[0].content[0].type).toBe("text");
    expect(pairsIntact(t.history)).toBe(true);
    // The most recent messages are the ones kept.
    expect(t.history.at(-1)).toEqual(long.at(-1));
  });

  it("never splits a tool_use from its tool_result even when the cut lands inside a turn", () => {
    // 4-message turns; cap 40 → the naive cut (length-40) can land on a tool_result message.
    const long = Array.from({ length: 11 }, (_, i) => turn(i + 1)).flat(); // 44 messages
    const t = trimHistory(withHistory(long));
    expect(pairsIntact(t.history)).toBe(true);
    expect(t.history[0]).toEqual({ role: "user", content: [{ type: "text", text: "msg 2" }] });
  });

  it("keeps the history unchanged when no safe boundary exists in the trimmable window", () => {
    // One user text followed by a very long run of tool_use/tool_result pairs: no user TEXT
    // message after the first → cutting anywhere would orphan a tool_result.
    const pairs: LlmMessage[] = [];
    for (let i = 0; i < 30; i++) {
      pairs.push({
        role: "assistant",
        content: [{ type: "tool_use", id: `tu_${i}`, name: "get_availability", input: {} }],
      });
      pairs.push({
        role: "user",
        content: [{ type: "tool_result", toolUseId: `tu_${i}`, content: "{}" }],
      });
    }
    const s = appendUserText(emptyState("+55a", NOW), "oi", NOW);
    const full = pairs.reduce((acc, m) => appendMessage(acc, m, NOW), s);
    expect(full.history.length).toBeGreaterThan(HISTORY_MAX_MESSAGES);
    expect(trimHistory(full)).toBe(full);
  });
});

describe("pruneOfferedSlots — past slots gone, cap on the rest (T239)", () => {
  it("drops slots that already started and keeps future ones", () => {
    let s = emptyState("+55a", NOW);
    s = recordOfferedSlots(
      s,
      ["2026-06-15T11:00:00.000Z", "2026-06-15T12:00:00.000Z", "2026-06-15T14:00:00.000Z"],
      NOW,
    );
    const p = pruneOfferedSlots(s, NOW);
    expect(p.offeredSlots).toEqual(["2026-06-15T14:00:00.000Z"]); // 12:00Z == now is not bookable either
  });

  it("caps to OFFERED_SLOTS_MAX keeping the most recently offered", () => {
    const many = Array.from({ length: OFFERED_SLOTS_MAX + 10 }, (_, i) =>
      new Date(NOW.getTime() + (i + 1) * 30 * 60_000).toISOString(),
    );
    const p = pruneOfferedSlots(recordOfferedSlots(emptyState("+55a", NOW), many, NOW), NOW);
    expect(p.offeredSlots).toHaveLength(OFFERED_SLOTS_MAX);
    expect(p.offeredSlots.at(-1)).toBe(many.at(-1));
    expect(p.offeredSlots[0]).toBe(many[10]);
  });

  it("returns the same reference when nothing changes", () => {
    const s = recordOfferedSlots(emptyState("+55a", NOW), ["2026-06-15T14:00:00.000Z"], NOW);
    expect(pruneOfferedSlots(s, NOW)).toBe(s);
  });
});

describe("boundState — composes every bound; identity when idle (T239)", () => {
  it("caps activeHoldIds and processedInboundIds keeping the most recent", () => {
    let s = emptyState("+55a", NOW);
    for (let i = 0; i < ACTIVE_HOLDS_MAX + 5; i++) s = recordHold(s, `h${i}`, NOW);
    for (let i = 0; i < PROCESSED_IDS_MAX + 5; i++) s = markProcessed(s, `m${i}`, NOW);
    const b = boundState(s, NOW);
    expect(b.activeHoldIds).toHaveLength(ACTIVE_HOLDS_MAX);
    expect(b.activeHoldIds.at(-1)).toBe(`h${ACTIVE_HOLDS_MAX + 4}`);
    expect(b.processedInboundIds).toHaveLength(PROCESSED_IDS_MAX);
    expect(b.processedInboundIds.at(-1)).toBe(`m${PROCESSED_IDS_MAX + 4}`);
    expect(b.processedInboundIds[0]).toBe("m5");
  });

  it("is a no-op (same reference) for a small, current state", () => {
    let s = emptyState("+55a", NOW);
    s = appendUserText(s, "oi", NOW);
    s = recordOfferedSlots(s, ["2026-06-15T14:00:00.000Z"], NOW);
    s = recordHold(s, "h1", NOW);
    s = markProcessed(s, "m1", NOW);
    expect(boundState(s, NOW)).toBe(s);
  });

  it("applies the history trim and the slot prune together", () => {
    const long = Array.from({ length: 15 }, (_, i) => turn(i + 1)).flat();
    let s = withHistory(long);
    s = recordOfferedSlots(s, ["2026-06-15T11:00:00.000Z", "2026-06-15T14:00:00.000Z"], NOW);
    const b = boundState(s, NOW);
    expect(b.history.length).toBeLessThanOrEqual(HISTORY_MAX_MESSAGES);
    expect(b.offeredSlots).toEqual(["2026-06-15T14:00:00.000Z"]);
  });
});
