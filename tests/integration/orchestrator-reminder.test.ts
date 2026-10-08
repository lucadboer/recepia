import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeLLM, finalTurn, toolUse, toolUseTurn } from "../../src/adapters/fakes/fake-llm";
import { recordConsent } from "../../src/agent/consent";
import { emptyState, setAwaitingConsent } from "../../src/agent/conversation";
import { handleInbound } from "../../src/agent/orchestrator";
import { TOOL_NAMES } from "../../src/agent/tool-schemas";
import type { Pool } from "../../src/db/pool";
import { getById } from "../../src/db/repositories/booking-repo";
import { AGENT_NOW, type AgentHarness, makeAgent } from "../helpers/agent";
import {
  countAudit,
  ensureSchema,
  resetDb,
  seedBooking,
  seedHeld,
  seedRule,
  testPool,
} from "../helpers/db";

// T713 / T715 (007) — a reply to a reminder: a plain "sim" confirms attendance with no model call;
// everything else reaches the model with the appointment in context, under the 006 gates.

const PHONE = "+5531900000750";
const START = "2026-06-16T12:00:00Z"; // tomorrow 09:00 local

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
  await seedRule(pool, { weekday: 2, startTime: "09:00", endTime: "18:00", capacity: 2 });
});

async function reminded(_h: AgentHarness, start = START, seat = 0): Promise<string> {
  const id = await seedBooking(pool, { start, phone: PHONE, name: "Ana Teste", seat });
  await pool.query("UPDATE booking SET reminder_sent_at = $2 WHERE id = $1", [id, AGENT_NOW]);
  // Delivered (only a delivered reminder is one the patient can be answering — 007 review).
  await pool.query(
    `INSERT INTO outbox_message (kind, to_phone, conversation_phone, body, dedupe_key, status, attempts, next_attempt_at, sent_at)
     VALUES ('appointment_reminder', $1, $1, 'lembrete', $2, 'sent', 1, $3, $3)`,
    [PHONE, `appointment_reminder:${id}`, AGENT_NOW],
  );
  return id;
}

async function setup(llm = new FakeLLM([])): Promise<AgentHarness> {
  const h = makeAgent(pool, llm);
  await recordConsent(h.deps, PHONE);
  return h;
}

const msg = (text: string, id: string) => ({ phone: PHONE, text, providerMessageId: id });

describe("the fast path: a plain 'sim' to the only pending reminder", () => {
  it("confirms attendance with zero model calls and one reply", async () => {
    const llm = new FakeLLM([]);
    const h = await setup(llm);
    const id = await reminded(h);
    const r = await handleInbound(h.deps, msg("Sim!", "r1"));
    expect(r.status).toBe("replied");
    expect(llm.callCount).toBe(0);
    expect((await getById(pool, id))?.status).toBe("patient_confirmed");
    expect(h.messaging.sent.map((m) => m.body)).toEqual([
      expect.stringMatching(/Presença confirmada/),
    ]);
    expect(await countAudit(pool, "attendance_confirmed")).toBe(1);
  });

  it("the quick-reply button text works the same way", async () => {
    const llm = new FakeLLM([]);
    const h = await setup(llm);
    const id = await reminded(h);
    await handleInbound(h.deps, msg("Confirmar presença", "r2"));
    expect(llm.callCount).toBe(0);
    expect((await getById(pool, id))?.status).toBe("patient_confirmed");
  });
});

describe("precedence — when 'sim' is NOT an attendance confirmation", () => {
  it("two pending reminders: the model decides (never an automatic guess)", async () => {
    const llm = new FakeLLM([finalTurn("Qual das consultas?")]);
    const h = await setup(llm);
    const a = await reminded(h);
    const b = await reminded(h, "2026-06-16T14:00:00Z");
    await handleInbound(h.deps, msg("sim", "r3"));
    expect(llm.callCount).toBe(1);
    expect((await getById(pool, a))?.status).toBe("confirmed");
    expect((await getById(pool, b))?.status).toBe("confirmed");
  });

  it("awaiting consent: 'sim' is the consent answer, attendance is not confirmed by it", async () => {
    const llm = new FakeLLM([finalTurn("Obrigado!")]);
    const h = makeAgent(pool, llm); // no consent yet
    const id = await reminded(h);
    await h.conversations.save({
      ...setAwaitingConsent(emptyState(PHONE, AGENT_NOW), true, AGENT_NOW),
    });
    await handleInbound(h.deps, msg("sim", "r4"));
    expect(await countAudit(pool, "consent_recorded")).toBe(1);
    expect((await getById(pool, id))?.status).toBe("confirmed");
  });

  it("a live hold in this conversation: 'sim' belongs to the booking in progress", async () => {
    const llm = new FakeLLM([finalTurn("ok")]);
    const h = await setup(llm);
    await reminded(h);
    await seedHeld(pool, "2026-06-15T15:00:00Z", PHONE, new Date(AGENT_NOW.getTime() + 5 * 60_000));
    const { rows } = await pool.query("SELECT id FROM booking WHERE status = 'held'");
    await h.conversations.save({ ...emptyState(PHONE, AGENT_NOW), activeHoldIds: [rows[0].id] });
    await handleInbound(h.deps, msg("sim", "r5"));
    expect(llm.callCount).toBe(1);
    expect(await countAudit(pool, "attendance_confirmed")).toBe(0);
  });

  it("'me tira da lista' is an opt-out, not a confirmation", async () => {
    const llm = new FakeLLM([]);
    const h = await setup(llm);
    const id = await reminded(h);
    await handleInbound(h.deps, msg("me tira da lista", "r6"));
    expect(await countAudit(pool, "consent_revoked")).toBe(1);
    expect((await getById(pool, id))?.status).toBe("confirmed");
    expect(llm.callCount).toBe(0);
  });
});

describe("the model path: the appointment is in context and counted as shown", () => {
  it("'sim, mas…' reaches the model with the reminder line after the dated line", async () => {
    let system = "";
    const llm = new FakeLLM([
      (i) => {
        system = i.system;
        return finalTurn("Para quando quer mudar?");
      },
    ]);
    const h = await setup(llm);
    const id = await reminded(h);
    await handleInbound(h.deps, msg("sim, mas preciso mudar o horário", "r7"));
    expect(llm.callCount).toBe(1);
    expect(system).toMatch(/Hoje é/);
    expect(system.indexOf(id)).toBeGreaterThan(system.indexOf("Hoje é"));
    expect(system).toMatch(/lembrete/i);
    const saved = await h.conversations.load(PHONE);
    expect(saved?.surfacedBookings).toEqual([{ bookingId: id, turn: saved?.turnSeq }]);
  });

  it("confirm_attendance is allowed in the same turn; cancel_booking still needs the round trip", async () => {
    const h = await setup();
    const id = await reminded(h);
    h.deps.llm = new FakeLLM([
      toolUseTurn(toolUse(TOOL_NAMES.cancelBooking, { booking_id: id })),
      toolUseTurn(toolUse(TOOL_NAMES.confirmAttendance, { booking_id: id })),
      finalTurn("Confirmado!"),
    ]);
    await handleInbound(h.deps, msg("confirmo sim, estarei lá amanhã cedo", "r8"));
    expect((await getById(pool, id))?.status).toBe("patient_confirmed");
    expect(await countAudit(pool, "booking_cancelled")).toBe(0);
    expect(h.messaging.sent.map((m) => m.body)).toEqual([
      expect.stringMatching(/Presença confirmada/), // the outbox reply only — no "Confirmado!"
    ]);
  });

  it("'não vou poder ir' → the agent asks, then cancels after the patient confirms", async () => {
    const h = await setup();
    const id = await reminded(h);
    h.deps.llm = new FakeLLM([finalTurn("Quer que eu cancele a consulta de amanhã às 09:00?")]);
    await handleInbound(h.deps, msg("não vou poder ir", "r9"));
    h.deps.llm = new FakeLLM([
      toolUseTurn(toolUse(TOOL_NAMES.cancelBooking, { booking_id: id })),
      finalTurn("ok"),
    ]);
    await handleInbound(h.deps, msg("isso, pode cancelar", "r10"));
    expect((await getById(pool, id))?.status).toBe("cancelled");
    expect(await countAudit(pool, "booking_cancelled")).toBe(1);
  });

  it("confirm_attendance on a booking that was never shown is refused (not_surfaced)", async () => {
    const h = await setup();
    const other = await seedBooking(pool, { start: "2026-06-16T15:00:00Z", phone: PHONE, seat: 1 });
    h.deps.llm = new FakeLLM([
      toolUseTurn(toolUse(TOOL_NAMES.confirmAttendance, { booking_id: other })),
      finalTurn("Não encontrei."),
    ]);
    await handleInbound(h.deps, msg("confirma minha presença", "r11"));
    expect((await getById(pool, other))?.status).toBe("confirmed");
  });
});

describe("007 review / live-run findings", () => {
  it("a 'sim' after the agent spoke since the reminder answers the agent, not the reminder", async () => {
    const llm = new FakeLLM([finalTurn("Certo, vou cancelar então?")]);
    const h = await setup(llm);
    const id = await reminded(h);
    // The agent already talked to the patient after the reminder went out.
    await h.conversations.save({ ...emptyState(PHONE, new Date(AGENT_NOW.getTime() + 60_000)) });
    h.clock.advance(2 * 60_000);
    await handleInbound(h.deps, msg("Confirmo.", "f1"));
    expect(llm.callCount).toBe(1); // routed to the model with the reminder in context
    expect((await getById(pool, id))?.status).toBe("confirmed");
  });

  it("an undelivered reminder is not one the patient can be answering", async () => {
    const llm = new FakeLLM([finalTurn("Oi!")]);
    const h = await setup(llm);
    const id = await seedBooking(pool, { start: START, phone: PHONE, name: "Ana Teste" });
    await pool.query("UPDATE booking SET reminder_sent_at = $2 WHERE id = $1", [id, AGENT_NOW]);
    await handleInbound(h.deps, msg("sim", "f2"));
    expect(llm.callCount).toBe(1);
    expect((await getById(pool, id))?.status).toBe("confirmed");
  });

  it("confirm_attendance is refused when the same message asks for a change (change_requested)", async () => {
    const h = await setup();
    const id = await reminded(h);
    h.deps.llm = new FakeLLM([
      toolUseTurn(toolUse(TOOL_NAMES.confirmAttendance, { booking_id: id })),
      finalTurn("Para quando quer mudar?"),
    ]);
    await handleInbound(h.deps, msg("Sim, mas preciso mudar o horário", "f3"));
    expect((await getById(pool, id))?.status).toBe("confirmed");
    expect(await countAudit(pool, "attendance_confirmed")).toBe(0);
  });

  it("'Me tira!' (bare, with punctuation) is still an opt-out", async () => {
    const llm = new FakeLLM([]);
    const h = await setup(llm);
    await reminded(h);
    await handleInbound(h.deps, msg("Me tira!", "f4"));
    expect(await countAudit(pool, "consent_revoked")).toBe(1);
  });
});
