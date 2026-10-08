import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeCalendar } from "../../src/adapters/fakes/fake-calendar";
import { FakeConversationStore } from "../../src/adapters/fakes/fake-conversation-store";
import { FakeLLM, finalTurn, toolUse, toolUseTurn } from "../../src/adapters/fakes/fake-llm";
import { recordConsent } from "../../src/agent/consent";
import { handleInbound } from "../../src/agent/orchestrator";
import { reply } from "../../src/agent/reply";
import { TOOL_NAMES } from "../../src/agent/tool-schemas";
import type { ConversationState } from "../../src/agent/types";
import type { Pool, PoolClient } from "../../src/db/pool";
import { committedTurnWrites } from "../../src/db/repositories/audit-repo";
import { getById } from "../../src/db/repositories/booking-repo";
import { confirmBooking } from "../../src/tools/confirm-booking";
import { holdSlot } from "../../src/tools/hold-slot";
import { AGENT_NOW, DAY_END, lastBookingId, lastHoldId, makeAgent } from "../helpers/agent";
import { countAudit, ensureSchema, resetDb, seedRule, testPool } from "../helpers/db";

// 008, found by the chaos test (seed 17): a turn whose booking committed but whose conversation
// state was never saved (the process died in between) is re-run when its message is reclaimed. The
// re-run must not book again — a message that already produced a final write is not replayed.

const PHONE = "+5531900000870";
const SLOT = "2026-06-15T14:00:00.000Z";

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

/** A store whose next save dies like a SIGKILL after the tools committed. */
class DyingStore extends FakeConversationStore {
  dieOnNextSave = true;
  override async save(state: ConversationState): Promise<ConversationState> {
    if (this.dieOnNextSave) {
      this.dieOnNextSave = false;
      throw new Error("process killed before the state was saved");
    }
    return super.save(state);
  }
}

/** The process dies while removing a calendar event: the first delete never returns. */
class HangingDeleteCalendar extends FakeCalendar {
  hung = false;
  override async deleteEvent(idempotencyKey: string): Promise<void> {
    if (!this.hung) {
      this.hung = true;
      return new Promise<void>(() => {});
    }
    return super.deleteEvent(idempotencyKey);
  }
}

async function until(cond: () => Promise<boolean>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function bookingLlm(): FakeLLM {
  return new FakeLLM([
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
  ]);
}

describe("replaying a message whose turn already committed (at-least-once delivery)", () => {
  it("does not book twice: the replay recognises the committed write and only finishes the message", async () => {
    const h = makeAgent(pool, bookingLlm());
    const store = new DyingStore();
    h.deps.conversations = store;
    await recordConsent(h.deps, PHONE);
    const msg = { phone: PHONE, text: "quero marcar uma limpeza", providerMessageId: "REPLAY-1" };

    await expect(handleInbound(h.deps, msg)).rejects.toThrow(/killed/);
    expect(await countAudit(pool, "booking_confirmed")).toBe(1);

    h.deps.llm = bookingLlm(); // a re-run would book again if it reached the model
    const replay = await handleInbound(h.deps, msg);

    expect(replay.status).toBe("noop");
    expect(await countAudit(pool, "booking_confirmed")).toBe(1);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM booking WHERE status = 'confirmed'",
    );
    expect(rows[0].n).toBe(1);
    // The conversation ends as the original turn would have saved it (a booking finishes it).
    const saved = await store.load(PHONE);
    expect(saved?.processedInboundIds).toContain("REPLAY-1");
    expect(saved?.status).toBe("completed");
    const booked = await pool.query("SELECT id FROM booking WHERE status = 'confirmed'");
    expect(saved?.lastConfirmedBookingId).toBe(booked.rows[0].id);
    // The patient still gets the confirmation the first run committed to the outbox.
    expect(
      h.messaging.sent
        .filter((m) => m.to === PHONE)
        .map((m) => m.body)
        .join(" "),
    ).toMatch(/confirmada/);
  });

  it("every final write carries the message that caused it (audit trail)", async () => {
    const h = makeAgent(pool, bookingLlm());
    await recordConsent(h.deps, PHONE);
    await handleInbound(h.deps, {
      phone: PHONE,
      text: "quero marcar uma limpeza",
      providerMessageId: "STAMP-1",
    });
    const { rows } = await pool.query(
      "SELECT payload FROM audit_log WHERE action = 'booking_confirmed'",
    );
    expect(rows[0].payload).toMatchObject({ inboundMessageId: "STAMP-1" });
  });

  it("a replay of a message that escalated restores the hand-off: reception keeps the conversation", async () => {
    const h = makeAgent(pool, new FakeLLM([]));
    const store = new DyingStore();
    h.deps.conversations = store;
    const msg = { phone: PHONE, text: "estou com muita dor", providerMessageId: "REPLAY-2" };
    await expect(handleInbound(h.deps, msg)).rejects.toThrow(/killed/);

    const replay = await handleInbound(h.deps, msg);
    expect(replay.status).toBe("escalated");
    expect((await store.load(PHONE))?.status).toBe("escalated");
    expect(await countAudit(pool, "escalated")).toBe(1); // reception is not notified twice
    // The first run died before telling the patient; the replay does, once.
    expect(h.messaging.sent.filter((m) => m.to === PHONE).map((m) => m.body)).toEqual([
      reply.escalatedToReception(),
    ]);
    // The next message stays with reception: no model call (the script is empty), no new hand-off.
    const next = await handleInbound(h.deps, {
      phone: PHONE,
      text: "alguém aí?",
      providerMessageId: "REPLAY-3",
    });
    expect(next.status).toBe("handed_off");
    expect(await countAudit(pool, "escalated")).toBe(1);
  });

  it("the replay lookup is served by its partial index", async () => {
    const client = await pool.connect();
    try {
      const seen: { text: string; values: unknown[] }[] = [];
      const spy = {
        query: (text: string, values: unknown[]) => {
          seen.push({ text, values });
          return client.query(text, values);
        },
      };
      await committedTurnWrites(spy as unknown as PoolClient, "ANY-MESSAGE");
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      const plan = await client.query(`EXPLAIN ${seen[0].text}`, seen[0].values);
      await client.query("ROLLBACK");
      expect(plan.rows.map((r) => r["QUERY PLAN"]).join("\n")).toContain(
        "audit_log_inbound_message_idx",
      );
    } finally {
      client.release();
    }
  });

  it("a replayed cancel finishes removing the calendar event the crash left behind", async () => {
    const calendar = new HangingDeleteCalendar();
    const h = makeAgent(pool, new FakeLLM([]));
    h.deps.calendar = calendar;
    await recordConsent(h.deps, PHONE);
    const hold = await holdSlot(
      h.deps,
      { start: new Date(SLOT), type: "cleaning" },
      { phone: PHONE },
    );
    const { booking } = await confirmBooking(h.deps, hold.id, { phone: PHONE, name: "Ana Teste" });
    expect(calendar.events.has(booking.id)).toBe(true);

    h.deps.llm = new FakeLLM([
      toolUseTurn(toolUse(TOOL_NAMES.findBooking, {})),
      finalTurn("Encontrei sua limpeza. Confirma o cancelamento?"),
    ]);
    await handleInbound(h.deps, {
      phone: PHONE,
      text: "quero cancelar",
      providerMessageId: "RC-1",
    });
    const msg = { phone: PHONE, text: "sim", providerMessageId: "RC-2" };
    h.deps.llm = new FakeLLM([
      (i) =>
        toolUseTurn(toolUse(TOOL_NAMES.cancelBooking, { booking_id: lastBookingId(i.messages) })),
      finalTurn("Cancelado!"),
    ]);
    // The process dies after the cancellation committed, while removing the calendar event.
    void handleInbound(h.deps, msg);
    await until(
      async () => calendar.hung && (await getById(pool, booking.id))?.status === "cancelled",
    );
    expect(calendar.events.has(booking.id)).toBe(true);

    h.deps.llm = new FakeLLM([]); // the replay must not reach the model
    expect((await handleInbound(h.deps, msg)).status).toBe("noop");
    expect(calendar.events.has(booking.id)).toBe(false);
    expect(await countAudit(pool, "booking_cancelled")).toBe(1);
  });

  it("keys on the durable inbound message, not the provider's id (two providers may reuse one)", async () => {
    const h = makeAgent(pool, bookingLlm());
    await recordConsent(h.deps, PHONE);
    await handleInbound(h.deps, {
      phone: PHONE,
      text: "quero marcar uma limpeza",
      providerMessageId: "SAME-ID",
      inboundMessageId: "101",
    });
    const { rows } = await pool.query(
      "SELECT payload FROM audit_log WHERE action = 'booking_confirmed'",
    );
    expect(rows[0].payload).toMatchObject({ inboundMessageId: "101" });

    // Another patient's message, from the other provider, with the same provider id.
    const llm = new FakeLLM([finalTurn("Olá! Como posso ajudar?")]);
    h.deps.llm = llm;
    const other = await handleInbound(h.deps, {
      phone: "+5531900000872",
      text: "oi",
      providerMessageId: "SAME-ID",
      inboundMessageId: "102",
    });
    expect(other.status).toBe("replied");
    expect(llm.callCount).toBe(1);
    expect((await h.conversations.load("+5531900000872"))?.lastConfirmedBookingId).toBeNull();
  });
});
