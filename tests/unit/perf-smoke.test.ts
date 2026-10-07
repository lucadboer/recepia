import { describe, expect, it } from "vitest";
import {
  assertDisposableDatabase,
  BookingScriptLLM,
  evaluateVerdict,
  percentile,
} from "../../scripts/perf-smoke";
import { TOOL_NAMES } from "../../src/agent/tool-schemas";
import type { LlmContent, LlmMessage, LlmTurnInput } from "../../src/ports/llm-port";

describe("perf smoke — percentile (nearest rank)", () => {
  it("picks the nearest-rank value and handles edges", () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
    expect(percentile([10, 20, 30, 40], 100)).toBe(40);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBe(0);
  });
});

describe("perf smoke — verdict (the gate itself)", () => {
  const run = (over: Partial<Parameters<typeof evaluateVerdict>[0][number]> = {}) => ({
    conversations: 40,
    turnP50Ms: 300,
    turnP95Ms: 700,
    ackP50Ms: 30,
    ackP95Ms: 100,
    wallMs: 2000,
    statuses: { replied: 30, max_iterations: 10 },
    errors: 0,
    conflicts: 0,
    confirmedBookings: 30,
    overbookedSlots: 0,
    ...over,
  });
  const opts = { p95BudgetMs: 1500, tolerance: 1.1, minConfirmedRatio: 0.5 };

  it("passes a healthy run", () => {
    expect(evaluateVerdict([run(), run()], opts).verdict.pass).toBe(true);
  });

  it("FAILS when nothing was booked even if latency and overbooking look fine [Codex P2]", () => {
    const v = evaluateVerdict(
      [run({ confirmedBookings: 0, statuses: { max_iterations: 40 } })],
      opts,
    ).verdict;
    expect(v.enoughBookings).toBe(false);
    expect(v.pass).toBe(false);
  });

  it("FAILS when a conversation vanished without a terminal status", () => {
    const v = evaluateVerdict([run({ statuses: { replied: 30 } })], opts).verdict;
    expect(v.allTurnsAccounted).toBe(false);
    expect(v.pass).toBe(false);
  });

  it("FAILS on any overbooked slot, on errors, and above budget + tolerance", () => {
    expect(evaluateVerdict([run({ overbookedSlots: 1 })], opts).verdict.pass).toBe(false);
    expect(evaluateVerdict([run({ errors: 1 })], opts).verdict.pass).toBe(false);
    expect(evaluateVerdict([run({ turnP95Ms: 1651 })], opts).verdict.withinBudget).toBe(false);
    expect(evaluateVerdict([run({ turnP95Ms: 1650 })], opts).verdict.withinBudget).toBe(true);
  });

  it("uses the MEDIAN p95 across repetitions", () => {
    const r = evaluateVerdict(
      [run({ turnP95Ms: 100 }), run({ turnP95Ms: 5000 }), run({ turnP95Ms: 200 })],
      opts,
    );
    expect(r.medianP95).toBe(200);
  });

  it("fails with no runs at all", () => {
    expect(evaluateVerdict([], opts).verdict.pass).toBe(false);
  });
});

describe("perf smoke — database safety guard", () => {
  const strict = {} as NodeJS.ProcessEnv;
  it("allows local hosts and refuses anything else unless explicitly allowed", () => {
    expect(() =>
      assertDisposableDatabase("postgres://u:p@localhost:5434/db", strict),
    ).not.toThrow();
    expect(() => assertDisposableDatabase("postgres://u:p@127.0.0.1/db", strict)).not.toThrow();
    expect(() => assertDisposableDatabase("postgres://u:p@db.prod.example.com/db", strict)).toThrow(
      /refusing to TRUNCATE/,
    );
    expect(() => assertDisposableDatabase(undefined, strict)).toThrow(/refusing to TRUNCATE/);
    // No CI bypass: a CI database is a local service anyway, and an exported CI=true elsewhere
    // must not widen the hole.
    expect(() =>
      assertDisposableDatabase("postgres://u:p@db.prod.example.com/db", { CI: "true" }),
    ).toThrow(/refusing to TRUNCATE/);
    expect(() =>
      assertDisposableDatabase("postgres://u:p@db.prod.example.com/db", {
        PERF_ALLOW_TRUNCATE: "1",
      }),
    ).not.toThrow();
  });
});

const user = (text: string): LlmMessage => ({ role: "user", content: [{ type: "text", text }] });
const toolResult = (content: string, isError = false): LlmMessage => ({
  role: "user",
  content: [{ type: "tool_result", toolUseId: "tu", content, isError }],
});
const assistantToolUse = (name: string, input: unknown): LlmMessage => ({
  role: "assistant",
  content: [{ type: "tool_use", id: "tu", name, input }],
});
const input = (messages: LlmMessage[]): LlmTurnInput => ({ system: "", tools: [], messages });
const firstToolUse = (c: LlmContent[]) => c.find((x) => x.type === "tool_use");

describe("perf smoke — BookingScriptLLM state machine", () => {
  const llm = new BookingScriptLLM();

  it("starts with get_availability", async () => {
    const r = await llm.turn(input([user("quero marcar uma limpeza #3")]));
    expect(firstToolUse(r.content)).toMatchObject({ name: TOOL_NAMES.availability });
  });

  it("holds one of the first slots, spread by the message index", async () => {
    const slots = { slots: ["a", "b", "c", "d", "e"].map((s) => ({ start: s })) };
    const r = await llm.turn(
      input([
        user("quero marcar uma limpeza #6"),
        assistantToolUse(TOOL_NAMES.availability, {}),
        toolResult(JSON.stringify(slots)),
      ]),
    );
    expect(firstToolUse(r.content)).toMatchObject({
      name: TOOL_NAMES.hold,
      input: { start: "c", type: "cleaning" }, // 6 % min(5, 4) = 2 → "c"
    });
  });

  it("skips slots it already tried and gives up when none are left", async () => {
    const slots = { slots: [{ start: "a" }, { start: "b" }] };
    const retry = await llm.turn(
      input([
        user("#0"),
        assistantToolUse(TOOL_NAMES.hold, { start: "a", type: "cleaning" }),
        toolResult("Esse horário acabou de ser preenchido.", true),
        assistantToolUse(TOOL_NAMES.availability, {}),
        toolResult(JSON.stringify(slots)),
      ]),
    );
    expect(firstToolUse(retry.content)).toMatchObject({ input: { start: "b" } });
    const exhausted = await llm.turn(
      input([
        user("#0"),
        assistantToolUse(TOOL_NAMES.hold, { start: "a", type: "cleaning" }),
        assistantToolUse(TOOL_NAMES.hold, { start: "b", type: "cleaning" }),
        toolResult(JSON.stringify(slots)),
      ]),
    );
    expect(exhausted.stopReason).toBe("end_turn");
  });

  it("confirms a hold, finishes after a booking, and re-checks availability after an error", async () => {
    const confirm = await llm.turn(
      input([user("#0"), toolResult(JSON.stringify({ holdId: "h1" }))]),
    );
    expect(firstToolUse(confirm.content)).toMatchObject({
      name: TOOL_NAMES.confirm,
      input: { hold_id: "h1" },
    });
    const done = await llm.turn(
      input([user("#0"), toolResult(JSON.stringify({ bookingId: "b1" }))]),
    );
    expect(done.stopReason).toBe("end_turn");
    const afterError = await llm.turn(input([user("#0"), toolResult("boom", true)]));
    expect(firstToolUse(afterError.content)).toMatchObject({ name: TOOL_NAMES.availability });
  });
});
