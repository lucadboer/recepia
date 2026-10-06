import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  FakeLLM,
  finalTurn,
  type ScriptedTurn,
  toolUse,
  toolUseTurn,
} from "../../src/adapters/fakes/fake-llm";
import { recordConsent } from "../../src/agent/consent";
import { handleInbound } from "../../src/agent/orchestrator";
import { reply } from "../../src/agent/reply";
import { TOOL_NAMES } from "../../src/agent/tool-schemas";
import type { InboundMessage } from "../../src/agent/types";
import { AGENT_MAX_ITERATIONS } from "../../src/config";
import type { Pool } from "../../src/db/pool";
import { enqueueOutbox } from "../../src/db/repositories/outbox-repo";
import { ConversationConflictError } from "../../src/domain/errors";
import { dispatchOutbox, OUTBOX_BACKOFF_MS } from "../../src/jobs/dispatch-outbox";
import type { LLMPort } from "../../src/ports/llm-port";
import { AGENT_NOW, DAY_END, lastHoldId, makeAgent, RECEPTION } from "../helpers/agent";
import {
  countAudit,
  ensureSchema,
  resetDb,
  seedConfirmed,
  seedRule,
  testPool,
} from "../helpers/db";

const PHONE = "+55pac";
const FIRST_SLOT = "2026-06-15T14:00:00.000Z"; // 11:00 local = now+2h

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

function inbound(text: string, id = "m1"): InboundMessage {
  return { phone: PHONE, text, providerMessageId: id };
}
async function bookingCount(): Promise<number> {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM booking");
  return rows[0].n;
}

describe("orchestrator — behavioral (assert tool side-effects, not LLM text)", () => {
  it("books end-to-end: availability -> hold -> confirm (1 event, consent stamped)", async () => {
    const llm = new FakeLLM([
      toolUseTurn(
        toolUse(TOOL_NAMES.availability, {
          from: AGENT_NOW.toISOString(),
          to: DAY_END,
          type: "cleaning",
        }),
      ),
      toolUseTurn(toolUse(TOOL_NAMES.hold, { start: FIRST_SLOT, type: "cleaning" })),
      (i) =>
        toolUseTurn(
          toolUse(TOOL_NAMES.confirm, { hold_id: lastHoldId(i.messages), patient_name: "João" }),
        ),
      finalTurn("Confirmado! Até breve."),
    ]);
    const h = makeAgent(pool, llm);
    await recordConsent(h.deps, PHONE);

    const r = await handleInbound(h.deps, inbound("quero marcar uma limpeza"));

    expect(r.status).toBe("replied");
    expect(h.calendar.createdCount).toBe(1);
    // The ONE patient message is the deterministic confirmation, delivered through the
    // outbox within the turn (nudge after the tool loop) — not the LLM's closing text.
    const toPatient = h.messaging.sent.filter((m) => m.to === PHONE);
    expect(toPatient).toHaveLength(1);
    expect(toPatient[0].body).toContain("confirmada");
    expect(await countAudit(pool, "booking_confirmed")).toBe(1);
    // The model is told today's date/time/timezone so it can build correct ISO ranges (FR-213).
    expect(llm.receivedInputs[0].system).toContain("segunda-feira");
    expect(llm.receivedInputs[0].system).toContain("15/06/2026");
    expect(llm.receivedInputs[0].system).toContain("America/Sao_Paulo");
    const { rows } = await pool.query(
      "SELECT consent_at, created_via FROM booking WHERE patient_phone = $1 AND status = 'confirmed'",
      [PHONE],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].consent_at).not.toBeNull();
    expect(rows[0].created_via).toBe("ai");
  });

  it("sends EXACTLY ONE patient message on a successful booking — no duplicate [T227]", async () => {
    const llm = new FakeLLM([
      toolUseTurn(
        toolUse(TOOL_NAMES.availability, {
          from: AGENT_NOW.toISOString(),
          to: DAY_END,
          type: "cleaning",
        }),
      ),
      toolUseTurn(toolUse(TOOL_NAMES.hold, { start: FIRST_SLOT, type: "cleaning" })),
      (i) =>
        toolUseTurn(
          toolUse(TOOL_NAMES.confirm, { hold_id: lastHoldId(i.messages), patient_name: "João" }),
        ),
      finalTurn("Confirmado! Até breve."),
    ]);
    const h = makeAgent(pool, llm);
    await recordConsent(h.deps, PHONE);

    const r = await handleInbound(h.deps, inbound("quero marcar uma limpeza"));

    expect(r.status).toBe("replied");
    expect(h.calendar.createdCount).toBe(1);
    // The deterministic confirmation (confirm_booking) is the SINGLE patient-facing
    // message; the orchestrator must NOT also send its closing LLM text on top of it.
    expect(h.messaging.sent.filter((m) => m.to === PHONE)).toHaveLength(1);
  });

  it("on a FAILED confirm the patient still gets exactly ONE message (not zero) [T227]", async () => {
    const llm = new FakeLLM([
      toolUseTurn(
        toolUse(TOOL_NAMES.availability, {
          from: AGENT_NOW.toISOString(),
          to: DAY_END,
          type: "cleaning",
        }),
      ),
      toolUseTurn(toolUse(TOOL_NAMES.hold, { start: FIRST_SLOT, type: "cleaning" })),
      (i) =>
        toolUseTurn(
          toolUse(TOOL_NAMES.confirm, { hold_id: lastHoldId(i.messages), patient_name: "João" }),
        ),
      finalTurn("Tive um problema ao confirmar; já acionei a recepção."),
    ]);
    const h = makeAgent(pool, llm);
    await recordConsent(h.deps, PHONE);
    h.calendar.failAlways = true; // confirm_booking fails persistently -> CalendarWriteError

    const r = await handleInbound(h.deps, inbound("quero marcar uma limpeza"));

    // confirm_booking escalated internally (persistent calendar failure) → the conversation is
    // handed off: deterministic hand-off reply (exactly one message), no further LLM call.
    expect(r.status).toBe("escalated");
    expect(h.calendar.createdCount).toBe(0); // no event written
    expect(h.messaging.sent.filter((m) => m.to === PHONE)).toEqual([
      { to: PHONE, body: reply.escalatedToReception() },
    ]);
    expect(h.messaging.sent.filter((m) => m.to === RECEPTION)).toHaveLength(1); // once, not twice
    expect(await countAudit(pool, "escalated")).toBe(1);
    expect(llm.callCount).toBe(3); // the scripted closing text was never requested
    expect((await h.conversations.load(PHONE))?.status).toBe("escalated");
    expect((await handleInbound(h.deps, inbound("e agora?", "m2"))).status).toBe("handed_off");
  });

  it("a re-confirm of an already-confirmed hold still sends exactly ONE message (not zero) [T227 #1]", async () => {
    const llm = new FakeLLM([
      // Turn 1: a normal booking — patient gets the deterministic confirmation.
      toolUseTurn(
        toolUse(TOOL_NAMES.availability, {
          from: AGENT_NOW.toISOString(),
          to: DAY_END,
          type: "cleaning",
        }),
      ),
      toolUseTurn(toolUse(TOOL_NAMES.hold, { start: FIRST_SLOT, type: "cleaning" })),
      (i) =>
        toolUseTurn(
          toolUse(TOOL_NAMES.confirm, { hold_id: lastHoldId(i.messages), patient_name: "João" }),
        ),
      finalTurn("Confirmado!"),
      // Turn 2: the LLM re-confirms the SAME (already-confirmed) hold, then replies.
      (i) =>
        toolUseTurn(
          toolUse(TOOL_NAMES.confirm, { hold_id: lastHoldId(i.messages), patient_name: "João" }),
        ),
      finalTurn("Sua consulta já está confirmada 🙂"),
    ]);
    const h = makeAgent(pool, llm);
    await recordConsent(h.deps, PHONE);

    await handleInbound(h.deps, inbound("quero marcar uma limpeza", "m1"));
    const beforeReconfirm = h.messaging.sent.filter((m) => m.to === PHONE).length;
    // A completed conversation resets on the next inbound (FR-212); keep it active here so
    // turn 2 genuinely re-confirms the same hold (the scenario this test pins).
    const afterTurn1 = await h.conversations.load(PHONE);
    if (afterTurn1) await h.conversations.save({ ...afterTurn1, status: "active" });

    const r2 = await handleInbound(h.deps, inbound("obrigado, ficou tudo certo?", "m2"));

    expect(r2.status).toBe("replied");
    expect(h.calendar.createdCount).toBe(1); // idempotent — still exactly one event
    // The re-confirm sends NO confirmation (idempotent), so the orchestrator must send
    // its closing reply — the patient can't be left with silence on a follow-up.
    const forReconfirm = h.messaging.sent.filter((m) => m.to === PHONE).length - beforeReconfirm;
    expect(forReconfirm).toBe(1);
  });

  it("a successful confirm that then loops to MAX_ITERATIONS still sends exactly ONE message (not two) [T227 #2]", async () => {
    const turns: ScriptedTurn[] = [
      toolUseTurn(
        toolUse(TOOL_NAMES.availability, {
          from: AGENT_NOW.toISOString(),
          to: DAY_END,
          type: "cleaning",
        }),
      ),
      toolUseTurn(toolUse(TOOL_NAMES.hold, { start: FIRST_SLOT, type: "cleaning" })),
      (i) =>
        toolUseTurn(
          toolUse(TOOL_NAMES.confirm, { hold_id: lastHoldId(i.messages), patient_name: "João" }),
        ),
    ];
    // After a successful confirm, keep emitting tool-use turns (never a final text) so
    // the loop runs to AGENT_MAX_ITERATIONS and hits the couldNotComplete branch.
    while (turns.length < AGENT_MAX_ITERATIONS) {
      turns.push(
        toolUseTurn(
          toolUse(TOOL_NAMES.availability, {
            from: AGENT_NOW.toISOString(),
            to: DAY_END,
            type: "cleaning",
          }),
        ),
      );
    }
    const llm = new FakeLLM(turns);
    const h = makeAgent(pool, llm);
    await recordConsent(h.deps, PHONE);

    const r = await handleInbound(h.deps, inbound("quero marcar uma limpeza"));

    expect(r.status).toBe("max_iterations");
    expect(h.calendar.createdCount).toBe(1); // the booking did succeed
    // The deterministic confirmation already went out; the max-iter branch must NOT
    // send couldNotComplete on top of it.
    expect(h.messaging.sent.filter((m) => m.to === PHONE)).toHaveLength(1);
  });

  it("LLM-never-writes: an unknown/hostile tool produces zero writes", async () => {
    const llm = new FakeLLM([
      toolUseTurn(toolUse("writeBooking", { sql: "DROP TABLE booking" })),
      finalTurn("ok"),
    ]);
    const h = makeAgent(pool, llm);
    await handleInbound(h.deps, inbound("oi"));
    expect(h.calendar.createdCount).toBe(0);
    expect(await bookingCount()).toBe(0);
  });

  it("confirm requires a hold created in this conversation (no event for a foreign holdId)", async () => {
    const llm = new FakeLLM([
      toolUseTurn(
        toolUse(TOOL_NAMES.confirm, {
          hold_id: "00000000-0000-0000-0000-000000000000",
          patient_name: "Intruso",
        }),
      ),
      finalTurn("ok"),
    ]);
    const h = makeAgent(pool, llm);
    await recordConsent(h.deps, PHONE); // pass the consent gate so guardrail-3 is what blocks
    await handleInbound(h.deps, inbound("pode confirmar"));
    expect(h.calendar.createdCount).toBe(0);
  });

  it("slots only come from get_availability (holding a never-offered slot writes nothing)", async () => {
    const llm = new FakeLLM([
      toolUseTurn(toolUse(TOOL_NAMES.hold, { start: FIRST_SLOT, type: "cleaning" })),
      finalTurn("ok"),
    ]);
    const h = makeAgent(pool, llm);
    await handleInbound(h.deps, inbound("quero marcar"));
    expect(await bookingCount()).toBe(0);
  });

  it("deterministic triage escalates WITHOUT calling the LLM", async () => {
    const llm = new FakeLLM([]); // would throw if ever called
    const h = makeAgent(pool, llm);
    const r = await handleInbound(h.deps, inbound("estou com muita dor"));
    expect(r.status).toBe("escalated");
    expect(llm.callCount).toBe(0);
    expect(await countAudit(pool, "escalated")).toBe(1);
    expect(h.messaging.sent.some((m) => m.to === RECEPTION)).toBe(true);
    expect(h.messaging.sent.some((m) => m.to === PHONE)).toBe(true);
    expect(await bookingCount()).toBe(0);
  });

  it("escalate_to_human tool carries the patient phone + conversation excerpt to reception [T236]", async () => {
    const llm = new FakeLLM([
      toolUseTurn(
        toolUse(TOOL_NAMES.escalate, {
          reason: "ambiguity",
          context: "Paciente pediu algo fora do escopo de rotina",
        }),
      ),
      finalTurn("Encaminhei para a recepção."),
    ]);
    const h = makeAgent(pool, llm);

    await handleInbound(h.deps, inbound("quero fazer um procedimento diferente"));

    const toReception = h.messaging.sent.filter((m) => m.to === RECEPTION);
    expect(toReception).toHaveLength(1);
    expect(toReception[0].body).toContain(`Paciente: ${PHONE}`);
    expect(toReception[0].body).toContain("Motivo: ambiguity");
    expect(toReception[0].body).toContain("- Paciente: quero fazer um procedimento diferente");
    const { rows } = await pool.query("SELECT payload FROM audit_log WHERE action = 'escalated'");
    expect(rows[0].payload.phone).toBe(PHONE);
  });

  it("max-iterations escalation carries the patient phone to reception [T236]", async () => {
    const script = Array.from({ length: AGENT_MAX_ITERATIONS + 2 }, () =>
      toolUseTurn(
        toolUse(TOOL_NAMES.availability, {
          from: AGENT_NOW.toISOString(),
          to: DAY_END,
          type: "cleaning",
        }),
      ),
    );
    const h = makeAgent(pool, new FakeLLM(script));
    await handleInbound(h.deps, inbound("quero marcar"));
    const toReception = h.messaging.sent.filter((m) => m.to === RECEPTION);
    expect(toReception).toHaveLength(1);
    expect(toReception[0].body).toContain(`Paciente: ${PHONE}`);
    expect(toReception[0].body).toContain("Motivo: max_iterations");
  });

  it("an escalate_to_human tool call ENDS the loop: no further LLM call, deterministic hand-off reply [T244]", async () => {
    const llm = new FakeLLM([
      toolUseTurn(toolUse(TOOL_NAMES.escalate, { reason: "ambiguity", context: "pedido confuso" })),
      // Would be turn 2 — must never be requested.
      toolUseTurn(toolUse(TOOL_NAMES.hold, { start: FIRST_SLOT, type: "cleaning" })),
      finalTurn("texto que não deve ser enviado"),
    ]);
    const h = makeAgent(pool, llm);

    const r = await handleInbound(h.deps, inbound("quero algo"));

    expect(r.status).toBe("escalated");
    expect(llm.callCount).toBe(1);
    const toPatient = h.messaging.sent.filter((m) => m.to === PHONE);
    expect(toPatient).toEqual([{ to: PHONE, body: reply.escalatedToReception() }]);
    expect(h.messaging.sent.filter((m) => m.to === RECEPTION)).toHaveLength(1);
    expect(await bookingCount()).toBe(0);
    const saved = await h.conversations.load(PHONE);
    expect(saved?.status).toBe("escalated");
    // History stays API-valid: the tool_use got its tool_result.
    const last = saved?.history.at(-1);
    expect(last?.role).toBe("user");
    expect(last?.content[0].type).toBe("tool_result");
  });

  it("a confirmation that could not be delivered yet is NOT replaced by LLM text; the outbox retries it [T244/T235]", async () => {
    const llm = new FakeLLM([
      toolUseTurn(
        toolUse(TOOL_NAMES.availability, {
          from: AGENT_NOW.toISOString(),
          to: DAY_END,
          type: "cleaning",
        }),
      ),
      toolUseTurn(toolUse(TOOL_NAMES.hold, { start: FIRST_SLOT, type: "cleaning" })),
      (i) =>
        toolUseTurn(
          toolUse(TOOL_NAMES.confirm, { hold_id: lastHoldId(i.messages), patient_name: "João" }),
        ),
      finalTurn("Confirmado! Até breve."),
    ]);
    const h = makeAgent(pool, llm);
    await recordConsent(h.deps, PHONE);
    h.messaging.failTimes = 1; // the in-turn dispatch attempt fails (provider hiccup)

    const r = await handleInbound(h.deps, inbound("quero marcar uma limpeza"));

    expect(r.status).toBe("replied");
    expect(h.calendar.createdCount).toBe(1);
    // Nothing reached the patient yet — and crucially NOT the LLM's closing text either:
    // the deterministic confirmation owns this message and is pending in the outbox.
    expect(h.messaging.sent.filter((m) => m.to === PHONE)).toHaveLength(0);

    h.clock.advance(OUTBOX_BACKOFF_MS[0]);
    await dispatchOutbox(h.deps);
    const toPatient = h.messaging.sent.filter((m) => m.to === PHONE);
    expect(toPatient).toHaveLength(1);
    expect(toPatient[0].body).toContain("confirmada");
  });

  it("when RECEPTION_PHONE equals the patient phone, the hand-off reply is not mistaken for a confirmation [T235]", async () => {
    const llm = new FakeLLM([
      toolUseTurn(toolUse(TOOL_NAMES.escalate, { reason: "ambiguity", context: "x" })),
    ]);
    const h = makeAgent(pool, llm);
    h.deps.receptionPhone = PHONE; // solo-demo artefact: reception == patient

    const r = await handleInbound(h.deps, inbound("quero algo"));

    expect(r.status).toBe("escalated");
    const bodies = h.messaging.sent.filter((m) => m.to === PHONE).map((m) => m.body);
    expect(bodies).toHaveLength(2); // the reception notice AND the patient hand-off reply
    expect(bodies).toContain(reply.escalatedToReception());
    expect(bodies.some((b) => b.includes("Motivo: ambiguity"))).toBe(true);
  });

  it("the in-turn outbox flush delivers only THIS conversation's rows — other conversations' rows wait for the scheduler, even those addressed to reception", async () => {
    const other = "+55outra";
    await enqueueOutbox(pool, {
      kind: "booking_confirmation",
      toPhone: other,
      conversationPhone: other,
      body: "pendente de outra conversa",
      now: AGENT_NOW,
    });
    await enqueueOutbox(pool, {
      kind: "escalation",
      toPhone: RECEPTION,
      conversationPhone: other,
      body: "escalação de OUTRA conversa",
      now: AGENT_NOW,
    });
    const h = makeAgent(pool, new FakeLLM([]));

    await handleInbound(h.deps, inbound("estou com muita dor")); // triage → this turn's own escalation

    const toReception = h.messaging.sent.filter((m) => m.to === RECEPTION);
    expect(toReception).toHaveLength(1);
    expect(toReception[0].body).toContain(`Paciente: ${PHONE}`);
    expect(h.messaging.sent.filter((m) => m.to === other)).toHaveLength(0);
    const { rows } = await pool.query(
      "SELECT status FROM outbox_message WHERE conversation_phone = $1",
      [other],
    );
    expect(rows.map((r) => r.status)).toEqual(["pending", "pending"]);
  });

  it("tools requested AFTER escalate_to_human in the SAME response are not executed [Codex P1]", async () => {
    const llm = new FakeLLM([
      toolUseTurn(
        toolUse(TOOL_NAMES.availability, {
          from: AGENT_NOW.toISOString(),
          to: DAY_END,
          type: "cleaning",
        }),
      ),
      toolUseTurn(toolUse(TOOL_NAMES.hold, { start: FIRST_SLOT, type: "cleaning" })),
      (i) =>
        toolUseTurn(
          toolUse(TOOL_NAMES.escalate, { reason: "ambiguity", context: "x" }, "tu_esc"),
          toolUse(
            TOOL_NAMES.confirm,
            { hold_id: lastHoldId(i.messages), patient_name: "João" },
            "tu_conf",
          ),
        ),
      finalTurn("não deve ser chamado"),
    ]);
    const h = makeAgent(pool, llm);
    await recordConsent(h.deps, PHONE);

    const r = await handleInbound(h.deps, inbound("quero marcar"));

    expect(r.status).toBe("escalated");
    expect(llm.callCount).toBe(3);
    expect(h.calendar.createdCount).toBe(0); // the confirm after the hand-off never ran
    expect(await countAudit(pool, "booking_confirmed")).toBe(0);
    const saved = await h.conversations.load(PHONE);
    expect(saved?.status).toBe("escalated"); // not overwritten by a late confirm
    const last = saved?.history.at(-1);
    const results = (last?.content ?? []).filter((c) => c.type === "tool_result");
    expect(results).toHaveLength(2); // both tool_use ids answered → history stays API-valid
    const cancelled = results.find((c) => c.type === "tool_result" && c.toolUseId === "tu_conf");
    expect(cancelled?.type === "tool_result" && cancelled.isError).toBe(true);
    expect((await handleInbound(h.deps, inbound("e aí?", "m2"))).status).toBe("handed_off");
  });

  it("a turn that loses the compare-and-swap delivers NOTHING: no outbox flush, no reply [Codex P2]", async () => {
    const llm = new FakeLLM([
      toolUseTurn(
        toolUse(TOOL_NAMES.availability, {
          from: AGENT_NOW.toISOString(),
          to: DAY_END,
          type: "cleaning",
        }),
      ),
      toolUseTurn(toolUse(TOOL_NAMES.hold, { start: FIRST_SLOT, type: "cleaning" })),
      (i) =>
        toolUseTurn(
          toolUse(TOOL_NAMES.confirm, { hold_id: lastHoldId(i.messages), patient_name: "João" }),
        ),
      finalTurn("Confirmado!"),
    ]);
    const h = makeAgent(pool, llm);
    await recordConsent(h.deps, PHONE);
    const base = h.conversations;
    h.deps.conversations = {
      load: (p) => base.load(p),
      save: async (s) => {
        throw new ConversationConflictError(s.phone, s.version); // another turn won
      },
    };

    await expect(handleInbound(h.deps, inbound("quero marcar uma limpeza"))).rejects.toBeInstanceOf(
      ConversationConflictError,
    );

    expect(h.calendar.createdCount).toBe(1); // the booking itself is committed (tools are idempotent)
    expect(h.messaging.sent.filter((m) => m.to === PHONE)).toHaveLength(0); // the loser stays silent
    const { rows } = await pool.query(
      "SELECT status FROM outbox_message WHERE kind = 'booking_confirmation'",
    );
    expect(rows.map((r) => r.status)).toEqual(["pending"]); // left for the scheduled dispatcher
  });

  it("bounds the loop at MAX_ITERATIONS, then escalates", async () => {
    const script = Array.from({ length: AGENT_MAX_ITERATIONS + 2 }, () =>
      toolUseTurn(
        toolUse(TOOL_NAMES.availability, {
          from: AGENT_NOW.toISOString(),
          to: DAY_END,
          type: "cleaning",
        }),
      ),
    );
    const llm = new FakeLLM(script);
    const h = makeAgent(pool, llm);
    const r = await handleInbound(h.deps, inbound("quero marcar"));
    expect(r.status).toBe("max_iterations");
    expect(llm.callCount).toBe(AGENT_MAX_ITERATIONS);
    expect(await countAudit(pool, "escalated")).toBe(1);
    expect(await bookingCount()).toBe(0);
  });

  it("is idempotent for a duplicate providerMessageId", async () => {
    const llm = new FakeLLM([finalTurn("olá")]);
    const h = makeAgent(pool, llm);
    const r1 = await handleInbound(h.deps, inbound("oi", "dup-1"));
    const r2 = await handleInbound(h.deps, inbound("oi", "dup-1"));
    expect(r1.status).toBe("replied");
    expect(r2.status).toBe("noop");
    expect(h.messaging.sent.filter((m) => m.to === PHONE)).toHaveLength(1);
    expect(llm.callCount).toBe(1);
  });

  it("recovers from a tool error (slot taken) by holding an alternative", async () => {
    let step = 0;
    const racing: LLMPort = {
      async turn(i) {
        step++;
        if (step === 1)
          return toolUseTurn(
            toolUse(TOOL_NAMES.availability, {
              from: AGENT_NOW.toISOString(),
              to: DAY_END,
              type: "cleaning",
            }),
          );
        if (step === 2) {
          // the offered 14:00 slot fills up before we hold it
          await seedConfirmed(pool, FIRST_SLOT, "+55x", 0);
          await seedConfirmed(pool, FIRST_SLOT, "+55y", 1);
          return toolUseTurn(toolUse(TOOL_NAMES.hold, { start: FIRST_SLOT, type: "cleaning" }));
        }
        if (step === 3)
          return toolUseTurn(
            toolUse(TOOL_NAMES.hold, { start: "2026-06-15T14:30:00.000Z", type: "cleaning" }),
          );
        if (step === 4)
          return toolUseTurn(
            toolUse(TOOL_NAMES.confirm, { hold_id: lastHoldId(i.messages), patient_name: "João" }),
          );
        return finalTurn("Confirmado no horário alternativo!");
      },
    };
    const h = makeAgent(pool, racing);
    await recordConsent(h.deps, PHONE);
    const r = await handleInbound(h.deps, inbound("quero marcar"));
    expect(r.status).toBe("replied");
    expect(h.calendar.createdCount).toBe(1);
    const { rows } = await pool.query(
      "SELECT start_ts FROM booking WHERE patient_phone = $1 AND status = 'confirmed'",
      [PHONE],
    );
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].start_ts).toISOString()).toBe("2026-06-15T14:30:00.000Z");
  });
});
