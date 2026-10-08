import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeLLM, finalTurn, toolUse, toolUseTurn } from "../../src/adapters/fakes/fake-llm";
import { recordConsent, recordOptOut } from "../../src/agent/consent";
import { handleInbound } from "../../src/agent/orchestrator";
import { TOOL_NAMES } from "../../src/agent/tool-schemas";
import type { InboundMessage } from "../../src/agent/types";
import type { Pool } from "../../src/db/pool";
import { getById } from "../../src/db/repositories/booking-repo";
import { confirmBooking } from "../../src/tools/confirm-booking";
import { holdSlot } from "../../src/tools/hold-slot";
import { type AgentHarness, lastBookingId, lastHoldId, makeAgent } from "../helpers/agent";
import { countAudit, ensureSchema, resetDb, seedRule, testPool } from "../helpers/db";

// T615 / T620 (006) — whole conversations through the orchestrator with the scripted model:
// a cancel takes two patient messages, a reschedule three, and the patient gets exactly one
// message for the change (the outbox one), never an extra closing text.

const PHONE = "+5531900000650";
const BOOKED = new Date("2026-06-17T12:00:00Z"); // Wed 09:00 local

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
  for (const weekday of [1, 2, 3]) {
    await seedRule(pool, { weekday, startTime: "09:00", endTime: "18:00", capacity: 2 });
  }
});

function inbound(text: string, id: string): InboundMessage {
  return { phone: PHONE, text, providerMessageId: id };
}

async function seedBooking(h: AgentHarness): Promise<string> {
  await recordConsent(h.deps, PHONE);
  const hold = await holdSlot(h.deps, { start: BOOKED, type: "cleaning" }, { phone: PHONE });
  const { booking } = await confirmBooking(h.deps, hold.id, { phone: PHONE, name: "Ana Teste" });
  h.messaging.sent.length = 0; // only the conversation under test counts
  await pool.query("UPDATE outbox_message SET status = 'sent', sent_at = now()");
  return booking.id;
}

describe("orchestrator — cancel (US1)", () => {
  it("shows the appointment, refuses a same-turn cancel, cancels after the patient says sim", async () => {
    const h = makeAgent(pool, new FakeLLM([]));
    const bookingId = await seedBooking(h);

    h.deps.llm = new FakeLLM([
      toolUseTurn(toolUse(TOOL_NAMES.findBooking, {})),
      (i) =>
        toolUseTurn(toolUse(TOOL_NAMES.cancelBooking, { booking_id: lastBookingId(i.messages) })),
      finalTurn("Encontrei sua limpeza de quarta, 17/06 às 09:00. Confirma o cancelamento?"),
    ]);
    const r1 = await handleInbound(h.deps, inbound("quero cancelar minha consulta", "lc1"));
    expect(r1.status).toBe("replied");
    expect((await getById(pool, bookingId))?.status).toBe("confirmed"); // FR-603
    expect(h.messaging.sent.map((m) => m.body)).toEqual([
      "Encontrei sua limpeza de quarta, 17/06 às 09:00. Confirma o cancelamento?",
    ]);

    h.deps.llm = new FakeLLM([
      (i) =>
        toolUseTurn(toolUse(TOOL_NAMES.cancelBooking, { booking_id: lastBookingId(i.messages) })),
      finalTurn("Cancelado!"),
    ]);
    await handleInbound(h.deps, inbound("sim", "lc2"));

    expect((await getById(pool, bookingId))?.status).toBe("cancelled");
    expect(h.calendar.events.has(bookingId)).toBe(false);
    const second = h.messaging.sent.slice(1).map((m) => m.body);
    expect(second).toHaveLength(1); // the outbox cancellation only — no extra "Cancelado!"
    expect(second[0]).toMatch(/foi cancelada/);
    expect((await h.conversations.load(PHONE))?.status).toBe("completed");
  });

  it("an opted-out patient can still cancel (it reduces data)", async () => {
    const h = makeAgent(pool, new FakeLLM([]));
    const bookingId = await seedBooking(h);
    await recordOptOut(h.deps, PHONE);
    h.deps.llm = new FakeLLM([
      toolUseTurn(toolUse(TOOL_NAMES.findBooking, {})),
      finalTurn("Confirma?"),
    ]);
    await handleInbound(h.deps, inbound("preciso desmarcar", "lo1"));
    h.deps.llm = new FakeLLM([
      (i) =>
        toolUseTurn(toolUse(TOOL_NAMES.cancelBooking, { booking_id: lastBookingId(i.messages) })),
      finalTurn("ok"),
    ]);
    await handleInbound(h.deps, inbound("isso mesmo", "lo2"));
    expect((await getById(pool, bookingId))?.status).toBe("cancelled");
  });
});

describe("orchestrator — reschedule (US2)", () => {
  it("find → availability + hold → sim: the appointment moves and one 'remarcada' message is sent", async () => {
    const h = makeAgent(pool, new FakeLLM([]));
    const bookingId = await seedBooking(h);

    h.deps.llm = new FakeLLM([
      toolUseTurn(toolUse(TOOL_NAMES.findBooking, {})),
      finalTurn("Sua limpeza é quarta às 09:00. Para quando quer mudar?"),
    ]);
    await handleInbound(h.deps, inbound("quero remarcar", "lr1"));

    h.deps.llm = new FakeLLM([
      toolUseTurn(
        toolUse(TOOL_NAMES.availability, {
          from: "2026-06-17T16:00:00Z",
          to: "2026-06-17T18:00:00Z",
          type: "cleaning",
        }),
      ),
      toolUseTurn(
        toolUse(TOOL_NAMES.hold, { start: "2026-06-17T16:00:00.000Z", type: "cleaning" }),
      ),
      (i) =>
        toolUseTurn(
          toolUse(TOOL_NAMES.rescheduleBooking, {
            booking_id: lastBookingId(i.messages),
            hold_id: lastHoldId(i.messages),
          }),
        ),
      finalTurn("Reservei quarta às 13:00. Confirma a troca?"),
    ]);
    await handleInbound(h.deps, inbound("quarta à tarde", "lr2"));
    expect((await getById(pool, bookingId))?.status).toBe("confirmed"); // hold of this turn: not yet

    h.deps.llm = new FakeLLM([
      (i) =>
        toolUseTurn(
          toolUse(TOOL_NAMES.rescheduleBooking, {
            booking_id: lastBookingId(i.messages),
            hold_id: lastHoldId(i.messages),
          }),
        ),
      finalTurn("Remarcado!"),
    ]);
    await handleInbound(h.deps, inbound("sim", "lr3"));

    expect((await getById(pool, bookingId))?.status).toBe("cancelled");
    expect(await countAudit(pool, "booking_rescheduled")).toBe(1);
    const last = h.messaging.sent.at(-1)?.body ?? "";
    expect(last).toMatch(/remarcada/);
    expect(last).toContain("17/06/2026 às 13:00");
    expect(h.messaging.sent.map((m) => m.body)).not.toContain("Remarcado!");
  });

  it("an opted-out patient is asked for consent before a reschedule commits", async () => {
    const h = makeAgent(pool, new FakeLLM([]));
    const bookingId = await seedBooking(h);
    await recordOptOut(h.deps, PHONE);
    h.deps.llm = new FakeLLM([
      toolUseTurn(toolUse(TOOL_NAMES.findBooking, {})),
      finalTurn("Para quando?"),
    ]);
    await handleInbound(h.deps, inbound("quero mudar o horário", "lx1"));
    h.deps.llm = new FakeLLM([
      toolUseTurn(
        toolUse(TOOL_NAMES.availability, {
          from: "2026-06-17T16:00:00Z",
          to: "2026-06-17T18:00:00Z",
          type: "cleaning",
        }),
      ),
      toolUseTurn(
        toolUse(TOOL_NAMES.hold, { start: "2026-06-17T16:00:00.000Z", type: "cleaning" }),
      ),
      finalTurn("Reservei 13:00, confirma?"),
    ]);
    await handleInbound(h.deps, inbound("quarta 13h", "lx2"));
    h.deps.llm = new FakeLLM([
      (i) =>
        toolUseTurn(
          toolUse(TOOL_NAMES.rescheduleBooking, {
            booking_id: lastBookingId(i.messages),
            hold_id: lastHoldId(i.messages),
          }),
        ),
      finalTurn("Preciso da sua autorização."),
    ]);
    await handleInbound(h.deps, inbound("sim", "lx3"));
    expect((await getById(pool, bookingId))?.status).toBe("confirmed");
    expect((await h.conversations.load(PHONE))?.awaitingConsent).toBe(true);
    expect(await countAudit(pool, "booking_rescheduled")).toBe(0);
  });
});

describe("orchestrator — hand-off when it is not clear (US3)", () => {
  it("two upcoming appointments: reception decides, nothing changes", async () => {
    const h = makeAgent(pool, new FakeLLM([]));
    const first = await seedBooking(h);
    const hold = await holdSlot(
      h.deps,
      { start: new Date("2026-06-17T13:00:00Z"), type: "cleaning" },
      { phone: PHONE },
    );
    await confirmBooking(h.deps, hold.id, { phone: PHONE, name: "Ana Teste" });
    h.deps.llm = new FakeLLM([toolUseTurn(toolUse(TOOL_NAMES.findBooking, {})), finalTurn("x")]);
    const r = await handleInbound(h.deps, inbound("cancela minha consulta", "lm1"));
    expect(r.status).toBe("escalated");
    expect((await getById(pool, first))?.status).toBe("confirmed");
  });
});
