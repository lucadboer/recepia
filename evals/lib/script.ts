// Compile a case's `llmScript` into the LLMPort the orchestrator drives in deterministic mode.
// One move per model call; moves are grouped per inbound turn (the runner calls `beginTurn`);
// placeholders are resolved from what the model has actually been shown (tool_results in the
// history) or from the seeded context — never from anything the script could not know.

import { ZERO_USAGE } from "../../src/adapters/fakes/fake-llm";
import { TOOL_NAMES } from "../../src/agent/tool-schemas";
import type {
  LLMPort,
  LlmContent,
  LlmMessage,
  LlmTurnInput,
  LlmTurnResult,
} from "../../src/ports/llm-port";
import type { EvalCase, ScriptMove, ToolMove } from "./case-schema";
import type { CaseContext } from "./runner";

export class ScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptError";
  }
}

/** An LLMPort that knows which inbound turn it is serving. */
export interface ScriptedLLM extends LLMPort {
  beginTurn(turnIndex: number): void;
  readonly callCount: number;
}

/** Starts of the LAST get_availability result in the history (an error result offers nothing). */
export function lastAvailability(messages: LlmMessage[]): string[] {
  const ids = new Set<string>();
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "tool_use" && b.name === TOOL_NAMES.availability) ids.add(b.id);
    }
  }
  let last: string[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type !== "tool_result" || !ids.has(b.toolUseId)) continue;
      if (b.isError) {
        last = [];
        continue;
      }
      try {
        const parsed = JSON.parse(b.content) as { slots?: { start: string }[] };
        last = (parsed.slots ?? []).map((s) => s.start);
      } catch {
        last = [];
      }
    }
  }
  return last;
}

/** The most recent holdId a tool_result carried, or null. */
export function lastHoldIdOf(messages: LlmMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const b of messages[i].content) {
      if (b.type !== "tool_result" || b.isError) continue;
      try {
        const parsed = JSON.parse(b.content) as { holdId?: string };
        if (typeof parsed.holdId === "string") return parsed.holdId;
      } catch {
        // not JSON
      }
    }
  }
  return null;
}

/** The booking find_my_booking last showed (a reschedule result carries `previousBookingId`). */
function lastBookingIdOf(messages: LlmMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const b of messages[i].content) {
      if (b.type !== "tool_result" || b.isError) continue;
      try {
        const parsed = JSON.parse(b.content) as { bookingId?: string; previousBookingId?: string };
        if (typeof parsed.bookingId === "string" && parsed.previousBookingId === undefined) {
          return parsed.bookingId;
        }
      } catch {
        // not JSON
      }
    }
  }
  return null;
}

const OFFERED = /^\$offeredSlot\[(\d+)\]$/;

function resolve(value: unknown, messages: LlmMessage[], ctx: CaseContext, where: string): unknown {
  if (Array.isArray(value)) return value.map((v, i) => resolve(v, messages, ctx, `${where}[${i}]`));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        resolve(v, messages, ctx, `${where}.${k}`),
      ]),
    );
  }
  if (typeof value !== "string" || !value.startsWith("$")) return value;
  const offered = OFFERED.exec(value);
  if (offered) {
    const slots = lastAvailability(messages);
    const n = Number(offered[1]);
    if (slots.length === 0)
      throw new ScriptError(
        `${where}: cannot resolve ${value} — no availability result in the history yet`,
      );
    if (n >= slots.length)
      throw new ScriptError(
        `${where}: cannot resolve ${value} — only ${slots.length} slot(s) offered`,
      );
    return slots[n];
  }
  if (value === "$lastHoldId") {
    const id = lastHoldIdOf(messages);
    if (id === null)
      throw new ScriptError(`${where}: cannot resolve $lastHoldId — no hold in the history yet`);
    return id;
  }
  if (value === "$lastBookingId") {
    const id = lastBookingIdOf(messages);
    if (id === null)
      throw new ScriptError(`${where}: cannot resolve $lastBookingId — no booking shown yet`);
    return id;
  }
  if (value === "$foreignBookingId") {
    if (ctx.foreignBookingId === null) {
      throw new ScriptError(
        `${where}: cannot resolve $foreignBookingId — the seed has no confirmed booking of another phone`,
      );
    }
    return ctx.foreignBookingId;
  }
  if (value === "$otherConversationHoldId") {
    if (ctx.otherConversationHoldId === null) {
      throw new ScriptError(
        `${where}: cannot resolve $otherConversationHoldId — the seed has no held booking of another phone`,
      );
    }
    return ctx.otherConversationHoldId;
  }
  if (value === "$foreignPhone") return ctx.foreignPhone;
  throw new ScriptError(`${where}: unknown placeholder ${value}`);
}

export function compileScript(c: EvalCase, ctx: CaseContext): ScriptedLLM {
  let turn = 0;
  let move = 0;
  let calls = 0;

  const toolBlock = (
    t: ToolMove,
    idx: number,
    messages: LlmMessage[],
    where: string,
  ): LlmContent => ({
    type: "tool_use",
    id: `tu_${c.id}_${turn}_${move}_${idx}`,
    name: t.tool,
    input: resolve(t.input, messages, ctx, `${where}.input`),
  });

  return {
    beginTurn(turnIndex: number): void {
      turn = turnIndex;
      move = 0;
    },
    get callCount(): number {
      return calls;
    },
    async turn(input: LlmTurnInput): Promise<LlmTurnResult> {
      calls++;
      const moves: ScriptMove[] | undefined = c.llmScript[turn];
      if (moves === undefined) {
        throw new ScriptError(
          `case "${c.id}": turn ${turn + 1} has no script (llmScript has ${c.llmScript.length} turn(s))`,
        );
      }
      const next = moves[move];
      if (next === undefined) {
        throw new ScriptError(
          `case "${c.id}": turn ${turn + 1} script exhausted after ${move} move(s)`,
        );
      }
      const where = `case "${c.id}" llmScript[${turn}][${move}]`;
      let content: LlmContent[];
      let stopReason: LlmTurnResult["stopReason"];
      if ("text" in next) {
        content = [{ type: "text", text: next.text }];
        stopReason = "end_turn";
      } else if ("tools" in next) {
        content = next.tools.map((t, i) => toolBlock(t, i, input.messages, `${where}.tools[${i}]`));
        stopReason = "tool_use";
      } else {
        content = [toolBlock(next, 0, input.messages, where)];
        stopReason = "tool_use";
      }
      move++;
      return { stopReason, content, usage: ZERO_USAGE };
    },
  };
}
