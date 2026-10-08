import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import {
  FakeLLM,
  finalTurn,
  type ScriptedTurn,
  toolUse,
  toolUseTurn,
} from "../../src/adapters/fakes/fake-llm";
import { recordConsent } from "../../src/agent/consent";
import { handleInbound } from "../../src/agent/orchestrator";
import { TOOL_NAMES } from "../../src/agent/tool-schemas";
import type { Pool } from "../../src/db/pool";
import { DbConversationStore } from "../../src/db/repositories/conversation-repo";
import { claimNext, type InboundRow, insertInbound } from "../../src/db/repositories/inbound-repo";
import { LeaseLostError } from "../../src/domain/errors";
import { createTurnLease } from "../../src/jobs/inbound-worker";
import type { CreateEventInput, CreateEventResult } from "../../src/ports/calendar-port";
import type { LlmTurnInput, LlmTurnResult } from "../../src/ports/llm-port";
import { AGENT_NOW, DAY_END, lastHoldId, makeAgent } from "../helpers/agent";
import { countAudit, ensureSchema, resetDb, seedRule, testPool } from "../helpers/db";

// 008 review (Codex P1): a worker whose lease expired can still be running its turn when another
// worker reclaims the message. From the moment it lost the message it must not write: every final
// write is fenced on the claim's lease inside its own transaction, and the turn re-checks the
// lease before each model call and each tool.

const PHONE = "+5531900000871";
const SLOT = "2026-06-15T14:00:00.000Z";
const MSG = { phone: PHONE, text: "quero marcar uma limpeza", providerMessageId: "LEASE-1" };

let pool: Pool;
beforeAll(async () => {
  pool = testPool();
  await ensureSchema(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetDb(pool);
  await seedRule(pool, { weekday: 1, startTime: "09:00", endTime: "18:00", capacity: 2 });
});

/** The message stored by the webhook and claimed by this worker. */
async function claimed(): Promise<InboundRow> {
  const client = await pool.connect();
  try {
    await insertInbound(client, MSG, "evolution", AGENT_NOW, 20);
  } finally {
    client.release();
  }
  const row = await claimNext(pool, "w1", AGENT_NOW, 60_000);
  if (!row) throw new Error("expected a claim");
  return row;
}

/** Another worker reclaims the message (as after an expired lease). */
async function takeOver(row: InboundRow): Promise<void> {
  await pool.query("UPDATE inbound_message SET locked_by = 'w2/other-claim' WHERE id = $1", [
    row.id,
  ]);
}

function bookingScript(): ScriptedTurn[] {
  return [
    toolUseTurn(
      toolUse(TOOL_NAMES.availability, {
        from: AGENT_NOW.toISOString(),
        to: DAY_END,
        type: "cleaning",
      }),
    ),
    toolUseTurn(toolUse(TOOL_NAMES.hold, { start: SLOT, type: "cleaning" })),
    (i) =>
      toolUseTurn(
        toolUse(TOOL_NAMES.confirm, { hold_id: lastHoldId(i.messages), patient_name: "Ana Teste" }),
      ),
    finalTurn("Confirmado!"),
  ];
}

/** Loses the message while the calendar event is being written (between the check and the commit). */
class TakeoverCalendar extends FakeCalendar {
  constructor(private readonly onCreate: () => Promise<void>) {
    super();
  }
  override async createEvent(input: CreateEventInput): Promise<CreateEventResult> {
    await this.onCreate();
    return super.createEvent(input);
  }
}

/** Loses the message during model call number `at`. */
class TakeoverLLM extends FakeLLM {
  private calls = 0;
  constructor(
    script: ScriptedTurn[],
    private readonly at: number,
    private readonly hook: () => Promise<void>,
  ) {
    super(script);
  }
  override async turn(input: LlmTurnInput): Promise<LlmTurnResult> {
    this.calls++;
    if (this.calls === this.at) await this.hook();
    return super.turn(input);
  }
}

describe("a turn whose message was taken over by another worker (fencing)", () => {
  it("with its lease held the turn runs as usual", async () => {
    const row = await claimed();
    const h = makeAgent(pool, new FakeLLM(bookingScript()));
    await recordConsent(h.deps, PHONE);
    h.deps.lease = createTurnLease(pool, row);
    await handleInbound(h.deps, MSG);
    expect(await countAudit(pool, "booking_confirmed")).toBe(1);
  });

  it("lost while the model was thinking: the tool it asked for never runs", async () => {
    const row = await claimed();
    const h = makeAgent(pool, new TakeoverLLM(bookingScript(), 3, () => takeOver(row)));
    await recordConsent(h.deps, PHONE);
    h.deps.lease = createTurnLease(pool, row);

    await expect(handleInbound(h.deps, MSG)).rejects.toBeInstanceOf(LeaseLostError);
    expect(h.calendar.createdCount).toBe(0);
    expect(await countAudit(pool, "booking_confirmed")).toBe(0);
    expect(await h.conversations.load(PHONE)).toBeNull(); // the stale turn saved nothing
    expect(h.messaging.sent).toEqual([]);
  });

  it("lost between the check and the commit: the write transaction refuses and the event is compensated", async () => {
    const row = await claimed();
    const h = makeAgent(pool, new FakeLLM(bookingScript()));
    await recordConsent(h.deps, PHONE);
    const calendar = new TakeoverCalendar(() => takeOver(row));
    h.deps.calendar = calendar;
    h.deps.lease = createTurnLease(pool, row);

    await expect(handleInbound(h.deps, MSG)).rejects.toBeInstanceOf(LeaseLostError);
    expect(await countAudit(pool, "booking_confirmed")).toBe(0);
    expect(await countAudit(pool, "escalated")).toBe(0); // the new holder owns the message now
    expect(calendar.events.size).toBe(0); // the stale turn's event was removed
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM booking WHERE status = 'confirmed'",
    );
    expect(rows[0].n).toBe(0);
    expect(await h.conversations.load(PHONE)).toBeNull();
    expect(h.messaging.sent).toEqual([]);
  });

  it("an escalation is fenced too: a stale turn never notifies reception", async () => {
    const row = await claimed();
    const h = makeAgent(pool, new FakeLLM([]));
    h.deps.lease = createTurnLease(pool, row);
    await takeOver(row);
    await expect(
      handleInbound(h.deps, { ...MSG, text: "estou com muita dor" }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(await countAudit(pool, "escalated")).toBe(0);
  });

  it("lost after the tools committed: the state save refuses, and the new holder's replay finishes the message", async () => {
    const row = await claimed();
    const h = makeAgent(pool, new TakeoverLLM(bookingScript(), 4, () => takeOver(row)));
    const store = new DbConversationStore(pool);
    h.deps.conversations = store;
    await recordConsent(h.deps, PHONE);
    h.deps.lease = createTurnLease(pool, row);

    await expect(handleInbound(h.deps, MSG)).rejects.toBeInstanceOf(LeaseLostError);
    expect(await countAudit(pool, "booking_confirmed")).toBe(1); // committed while it held the lease
    expect(await store.load(PHONE)).toBeNull(); // the save was fenced in its own transaction
    expect(h.messaging.sent).toEqual([]);

    // The worker that took the message over replays it: no second booking, the confirmation the
    // first attempt committed is delivered, the conversation is finished.
    h.deps.llm = new FakeLLM([]);
    h.deps.lease = createTurnLease(pool, { id: row.id, lease: "w2/other-claim" });
    expect((await handleInbound(h.deps, MSG)).status).toBe("noop");
    expect(await countAudit(pool, "booking_confirmed")).toBe(1);
    expect((await store.load(PHONE))?.status).toBe("completed");
    expect(h.messaging.sent.map((m) => m.body).join(" ")).toMatch(/confirmada/);
  });

  it("a stale opt-out is not recorded (consent writes are fenced too)", async () => {
    const row = await claimed();
    const h = makeAgent(pool, new FakeLLM([]));
    await recordConsent(h.deps, PHONE);
    h.deps.lease = createTurnLease(pool, row);
    await takeOver(row);
    await expect(handleInbound(h.deps, { ...MSG, text: "me tira" })).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    expect(await countAudit(pool, "consent_revoked")).toBe(0);
  });
});
