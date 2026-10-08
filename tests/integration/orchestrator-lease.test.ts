import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeConversationStore } from "../../src/adapters/fakes/fake-conversation-store";
import {
  FakeLLM,
  finalTurn,
  type ScriptedTurn,
  toolUse,
  toolUseTurn,
} from "../../src/adapters/fakes/fake-llm";
import { FakeMessaging } from "../../src/adapters/fakes/fake-messaging";
import { recordConsent } from "../../src/agent/consent";
import { handleInbound } from "../../src/agent/orchestrator";
import { TOOL_NAMES } from "../../src/agent/tool-schemas";
import type { ConversationState } from "../../src/agent/types";
import { HOLD_TTL_MS } from "../../src/config";
import type { Pool } from "../../src/db/pool";
import { DbConversationStore } from "../../src/db/repositories/conversation-repo";
import { claimNext, type InboundRow, insertInbound } from "../../src/db/repositories/inbound-repo";
import { HoldExpiredError, LeaseLostError } from "../../src/domain/errors";
import { expireHolds, removeAbandonedEvents } from "../../src/jobs/expire-holds";
import { createTurnLease } from "../../src/jobs/inbound-worker";
import type { CreateEventInput, CreateEventResult } from "../../src/ports/calendar-port";
import type { SaveOptions } from "../../src/ports/conversation-store-port";
import type { LlmTurnInput, LlmTurnResult } from "../../src/ports/llm-port";
import type { MessageTemplate } from "../../src/ports/messaging-port";
import { confirmBooking } from "../../src/tools/confirm-booking";
import { holdSlot } from "../../src/tools/hold-slot";
import { rescheduleBooking } from "../../src/tools/reschedule-booking";
import { AGENT_NOW, DAY_END, lastHoldId, makeAgent, RECEPTION } from "../helpers/agent";
import { countAudit, ensureSchema, resetDb, seedRule, testPool } from "../helpers/db";
import { interceptingPool } from "../helpers/pool";

// 008 review (Codex P1): a worker whose lease expired can still be running its turn when another
// worker reclaims the message. From the moment it lost the message it must not write: every final
// write is fenced on the claim's lease inside its own transaction, and the turn re-checks the
// lease before each model call and each tool.

const PHONE = "+5531900000871";
const SLOT = "2026-06-15T14:00:00.000Z";
const LATER = "2026-06-15T16:00:00.000Z";
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
const OTHER = "w2/other-claim";
async function takeOver(row: InboundRow): Promise<void> {
  await pool.query("UPDATE inbound_message SET locked_by = $2 WHERE id = $1", [row.id, OTHER]);
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
  takeover = true;
  constructor(private readonly onCreate: () => Promise<void>) {
    super();
  }
  override async createEvent(input: CreateEventInput): Promise<CreateEventResult> {
    if (this.takeover) await this.onCreate();
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

/** A store whose next save dies like a SIGKILL after the tools committed. */
class DyingStore extends FakeConversationStore {
  dieOnNextSave = true;
  override async save(state: ConversationState, opts?: SaveOptions): Promise<ConversationState> {
    if (this.dieOnNextSave) {
      this.dieOnNextSave = false;
      throw new Error("process killed before the state was saved");
    }
    return super.save(state, opts);
  }
}

/** Loses the message while the outbox delivers the reception notice. */
class TakeoverMessaging extends FakeMessaging {
  constructor(private readonly onReception: () => Promise<void>) {
    super();
  }
  override async sendMessage(to: string, body: string, template?: MessageTemplate): Promise<void> {
    await super.sendMessage(to, body, template);
    if (to === RECEPTION) await this.onReception();
  }
}

/** A calendar whose deletes wait for `gate` (a compensation still in flight). */
class SlowDeleteCalendar extends FakeCalendar {
  deleting = false;
  constructor(private readonly gate: Promise<void>) {
    super();
  }
  override async deleteEvent(idempotencyKey: string): Promise<void> {
    this.deleting = true;
    await this.gate;
    return super.deleteEvent(idempotencyKey);
  }
}

async function until(cond: () => Promise<boolean> | boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
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

  it("lost between the check and the commit: the write refuses and the hold and its event are left to the new holder", async () => {
    const row = await claimed();
    const h = makeAgent(pool, new FakeLLM(bookingScript()));
    await recordConsent(h.deps, PHONE);
    const calendar = new TakeoverCalendar(() => takeOver(row));
    h.deps.calendar = calendar;
    h.deps.lease = createTurnLease(pool, row);

    await expect(handleInbound(h.deps, MSG)).rejects.toBeInstanceOf(LeaseLostError);
    expect(await countAudit(pool, "booking_confirmed")).toBe(0);
    expect(await countAudit(pool, "escalated")).toBe(0); // the new holder owns the message now
    expect(await h.conversations.load(PHONE)).toBeNull();
    expect(h.messaging.sent).toEqual([]);
    // The stale turn touched neither the hold nor its event (the new holder may confirm that same
    // hold, with that same event); it only flagged the hold.
    const { rows } = await pool.query(
      "SELECT id, status, event_cleanup_pending FROM booking WHERE status <> 'cancelled'",
    );
    expect(rows).toEqual([{ id: expect.any(String), status: "held", event_cleanup_pending: true }]);
    expect(calendar.events.has(rows[0].id)).toBe(true);
    // If the hold ends unconfirmed, the hold sweep removes the event.
    h.clock.advance(HOLD_TTL_MS + 1);
    await expireHolds(h.deps);
    expect(await removeAbandonedEvents(h.deps)).toBe(1);
    expect(calendar.events.size).toBe(0);
  });

  it("a stale confirm leaves the hold usable: the new holder confirms it with the same event", async () => {
    const row = await claimed();
    const h = makeAgent(pool, new FakeLLM([]));
    await recordConsent(h.deps, PHONE);
    const hold = await holdSlot(
      h.deps,
      { start: new Date(SLOT), type: "cleaning" },
      { phone: PHONE },
    );
    const calendar = new TakeoverCalendar(() => takeOver(row));
    const stale = { ...h.deps, calendar, lease: createTurnLease(pool, row) };
    await expect(
      confirmBooking(stale, hold.id, { phone: PHONE, name: "Ana Teste" }),
    ).rejects.toBeInstanceOf(LeaseLostError);

    calendar.takeover = false;
    const fresh = {
      ...h.deps,
      calendar,
      lease: createTurnLease(pool, { id: row.id, lease: OTHER }),
    };
    const { booking, outcome } = await confirmBooking(fresh, hold.id, {
      phone: PHONE,
      name: "Ana Teste",
    });
    expect(outcome).toBe("confirmed");
    expect(booking.status).toBe("confirmed");
    expect(calendar.events.size).toBe(1);
  });

  it("a stale reschedule leaves the hold usable: the new holder completes it", async () => {
    const row = await claimed();
    const h = makeAgent(pool, new FakeLLM([]));
    await recordConsent(h.deps, PHONE);
    const first = await holdSlot(
      h.deps,
      { start: new Date(SLOT), type: "cleaning" },
      { phone: PHONE },
    );
    const { booking: old } = await confirmBooking(h.deps, first.id, {
      phone: PHONE,
      name: "Ana Teste",
    });
    const hold = await holdSlot(
      h.deps,
      { start: new Date(LATER), type: "cleaning" },
      { phone: PHONE },
    );
    const calendar = new TakeoverCalendar(() => takeOver(row));
    for (const [k, v] of h.calendar.events) calendar.events.set(k, v);
    const stale = { ...h.deps, calendar, lease: createTurnLease(pool, row) };
    await expect(rescheduleBooking(stale, old.id, hold.id, PHONE)).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    const held = await pool.query("SELECT status FROM booking WHERE id = $1", [hold.id]);
    expect(held.rows[0].status).toBe("held"); // not released by the stale attempt
    expect(await countAudit(pool, "escalated")).toBe(0);

    calendar.takeover = false;
    const fresh = {
      ...h.deps,
      calendar,
      lease: createTurnLease(pool, { id: row.id, lease: OTHER }),
    };
    const r = await rescheduleBooking(fresh, old.id, hold.id, PHONE);
    expect(r.outcome).toBe("rescheduled");
    expect(calendar.events.has(hold.id)).toBe(true);
    expect(calendar.events.has(old.id)).toBe(false);
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
    h.deps.lease = createTurnLease(pool, { id: row.id, lease: OTHER });
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

  it("a reply is never sent once the message was taken over (every direct send is fenced)", async () => {
    // First run: the escalation commits, then the process dies before saving the state.
    const row = await claimed();
    const h = makeAgent(pool, new FakeLLM([]));
    h.deps.conversations = new DyingStore();
    const urgent = { ...MSG, text: "estou com muita dor" };
    await expect(handleInbound(h.deps, urgent)).rejects.toThrow(/killed/);

    // The replay delivers the committed reception notice — and loses the message meanwhile.
    const messaging = new TakeoverMessaging(() => takeOver(row));
    h.deps.messaging = messaging;
    h.deps.lease = createTurnLease(pool, row);
    await expect(handleInbound(h.deps, urgent)).rejects.toBeInstanceOf(LeaseLostError);
    expect(messaging.sent.map((m) => m.to)).toEqual([RECEPTION]); // nothing to the patient
  });

  it("an event is only deleted after its hold is ended: a late compensation never hits a new confirm", async () => {
    const row = await claimed();
    const h = makeAgent(pool, new FakeLLM([]));
    await recordConsent(h.deps, PHONE);
    const hold = await holdSlot(
      h.deps,
      { start: new Date(SLOT), type: "cleaning" },
      { phone: PHONE },
    );
    // The confirm's commit fails, so its event is an orphan to compensate; the delete is slow.
    let release: () => void = () => {};
    const slowDelete = new Promise<void>((r) => {
      release = r;
    });
    const calendar = new SlowDeleteCalendar(slowDelete);
    const failing = interceptingPool(pool, {
      reject: (sql) =>
        sql.includes("SET status = 'confirmed', patient_name") ? new Error("commit lost") : null,
    });
    const stale = { ...h.deps, pool: failing, calendar, lease: createTurnLease(pool, row) };
    const compensation = confirmBooking(stale, hold.id, { phone: PHONE, name: "Ana Teste" }).catch(
      (err: unknown) => err,
    );
    await until(async () => calendar.deleting);

    // Meanwhile the turn times out and another attempt tries to confirm the same hold: it cannot,
    // the hold was ended before the delete started.
    await takeOver(row);
    const fresh = {
      ...h.deps,
      calendar,
      lease: createTurnLease(pool, { id: row.id, lease: OTHER }),
    };
    await expect(
      confirmBooking(fresh, hold.id, { phone: PHONE, name: "Ana Teste" }),
    ).rejects.toBeInstanceOf(HoldExpiredError);

    release();
    await compensation;
    expect(calendar.events.has(hold.id)).toBe(false);
    expect(await countAudit(pool, "booking_confirmed")).toBe(0);
  });
});
