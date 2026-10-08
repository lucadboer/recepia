import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SpanKind } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeLLM, finalTurn, toolUse, toolUseTurn } from "../../src/adapters/fakes/fake-llm";
import { recordConsent } from "../../src/agent/consent";
import { handleInbound } from "../../src/agent/orchestrator";
import { PROMPT_VERSION } from "../../src/agent/system-prompt";
import { TOOL_NAMES } from "../../src/agent/tool-schemas";
import type { Pool } from "../../src/db/pool";
import { messageRef } from "../../src/telemetry/pseudonym";
import { withSpan } from "../../src/telemetry/tracing";
import { confirmBooking } from "../../src/tools/confirm-booking";
import { holdSlot } from "../../src/tools/hold-slot";
import { createWebhookServer } from "../../src/webhook/server";
import { AGENT_NOW, DAY_END, lastHoldId, makeAgent } from "../helpers/agent";
import { ensureSchema, resetDb, seedRule, testPool } from "../helpers/db";
import { startTestTelemetry, type TestTelemetry, telemetryStrings } from "../helpers/telemetry";

// T511 — one trace per patient message with the full step tree, linked delivery, guardrail
// names on rejected tools, and no personal data anywhere in the exported spans (FR-501..505).

const SECRET = "s3cr3t-token";
const PHONE = "+5531900000101";
const JID = "5531900000101@s.whatsapp.net";
const FIRST_SLOT = "2026-06-15T14:00:00.000Z";
const BOOKING_TEXT = "quero marcar uma limpeza hoje cedo";

let pool: Pool;
let tel: TestTelemetry;
beforeAll(async () => {
  pool = testPool();
  await ensureSchema(pool);
  tel = startTestTelemetry();
});
afterAll(async () => {
  await tel.stop();
  await pool.end();
});
beforeEach(async () => {
  await resetDb(pool);
  await seedRule(pool, { weekday: 1, startTime: "09:00", endTime: "18:00", capacity: 2 });
  tel.reset();
});

const upsert = (id: string, text: string) =>
  JSON.stringify({
    event: "messages.upsert",
    data: { key: { remoteJid: JID, fromMe: false, id }, message: { conversation: text } },
  });

async function untilSpans(name: string, n: number): Promise<void> {
  for (let i = 0; i < 200 && tel.byName(name).length < n; i++)
    await new Promise((r) => setTimeout(r, 10));
}

const childrenOf = (parent: ReadableSpan) =>
  tel.spans().filter((s) => s.parentSpanContext?.spanId === parent.spanContext().spanId);

function bookingLlm(): FakeLLM {
  return new FakeLLM([
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
        toolUse(TOOL_NAMES.confirm, { hold_id: lastHoldId(i.messages), patient_name: "Ana Teste" }),
      ),
    finalTurn("Confirmado!"),
  ]);
}

describe("tracing — booking through the webhook", () => {
  let server: Server | null = null;
  afterAll(() => server?.close());

  it("produces one trace per message: inbound → turn → chat/tool steps → linked delivery, no PII", async () => {
    const h = makeAgent(pool, bookingLlm());
    await recordConsent(h.deps, PHONE);
    server = createWebhookServer({ secret: SECRET, onInbound: (m) => handleInbound(h.deps, m) });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/webhook/evolution/${SECRET}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: SECRET },
      body: upsert("MSG-1", BOOKING_TEXT),
    });
    expect(res.status).toBe(200);
    await untilSpans("webhook.inbound", 1);

    const [inbound] = tel.byName("webhook.inbound");
    expect(inbound.parentSpanContext).toBeUndefined(); // a root per patient message
    expect(inbound.kind).toBe(SpanKind.CONSUMER);
    expect(inbound.attributes).toMatchObject({
      "recepia.channel": "evolution",
      "recepia.message.ref": messageRef("MSG-1"), // keyed: a wamid encodes the phone
      "recepia.patient.phone_masked": "***0101",
    });
    expect(inbound.attributes["recepia.patient.id"]).toMatch(/^[0-9a-f]{16}$/);

    const [turn] = tel.byName("agent.turn");
    expect(turn.parentSpanContext?.spanId).toBe(inbound.spanContext().spanId);
    expect(turn.attributes).toMatchObject({
      "recepia.turn.status": "replied",
      "recepia.conversation.status": "completed",
      "recepia.prompt.version": PROMPT_VERSION,
    });

    const chats = tel.spans().filter((s) => s.name.startsWith("chat "));
    expect(chats).toHaveLength(4);
    for (const c of chats) {
      expect(c.parentSpanContext?.spanId).toBe(turn.spanContext().spanId);
      expect(c.attributes["gen_ai.operation.name"]).toBe("chat");
      expect(c.attributes["recepia.prompt.version"]).toBe(PROMPT_VERSION);
      expect(c.attributes["gen_ai.usage.input_tokens"]).toBe(0);
    }
    expect(chats.map((c) => c.attributes["gen_ai.response.finish_reasons"])).toEqual([
      ["tool_use"],
      ["tool_use"],
      ["tool_use"],
      ["end_turn"],
    ]);

    const tools = tel.spans().filter((s) => s.name.startsWith("execute_tool "));
    expect(
      tools.map((t) => [t.attributes["gen_ai.tool.name"], t.attributes["recepia.tool.outcome"]]),
    ).toEqual([
      [TOOL_NAMES.availability, "ok"],
      [TOOL_NAMES.hold, "ok"],
      [TOOL_NAMES.confirm, "ok"],
    ]);
    const hold = tools[1];
    expect(hold.attributes).toMatchObject({
      "recepia.tool.appointment_type": "cleaning",
      "recepia.tool.slot_start": FIRST_SLOT,
    });

    const [dispatch] = tel.byName("outbox.dispatch");
    expect(dispatch.attributes["recepia.outbox.result"]).toBe("sent");
    expect(dispatch.spanContext().traceId).toBe(inbound.spanContext().traceId); // flushed inside the turn
    expect(dispatch.links[0]?.context.spanId).toBe(tools[2].spanContext().spanId); // committed by confirm
    expect(childrenOf(turn).map((s) => s.name)).toContain("outbox.dispatch");

    // FR-505: nothing exported identifies the patient or repeats what anyone wrote.
    const strings = telemetryStrings(tel.spans());
    for (const s of strings) {
      expect(s).not.toContain("5531900000101");
      expect(s).not.toContain(BOOKING_TEXT);
      expect(s).not.toContain("Ana Teste");
      expect(s).not.toContain("Confirmado");
    }
  });
});

describe("tracing — turn shapes and guardrail names (handleInbound)", () => {
  async function runTurn(llm: FakeLLM, text: string, consent = true): Promise<void> {
    const h = makeAgent(pool, llm);
    if (consent) await recordConsent(h.deps, PHONE);
    await withSpan("test.root", {}, () =>
      handleInbound(h.deps, { phone: PHONE, text, providerMessageId: `m-${text.length}` }),
    );
  }

  it("a triage escalation produces no chat span and an escalated turn", async () => {
    await runTurn(new FakeLLM([]), "estou com muita dor");
    expect(tel.spans().filter((s) => s.name.startsWith("chat "))).toHaveLength(0);
    const [turn] = tel.byName("agent.turn");
    expect(turn.attributes["recepia.turn.status"]).toBe("escalated");
    expect(turn.attributes["recepia.prompt.version"]).toBeUndefined(); // no model involved
    const strings = telemetryStrings(tel.spans());
    expect(strings.some((s) => s.includes("dor"))).toBe(false);
  });

  it("hostile moves are recorded with the guardrail that rejected them", async () => {
    const llm = new FakeLLM([
      toolUseTurn(toolUse("cancel_all_bookings", {})),
      toolUseTurn(toolUse(TOOL_NAMES.hold, { start: FIRST_SLOT, type: "cleaning" })),
      toolUseTurn(
        toolUse(TOOL_NAMES.confirm, {
          hold_id: "00000000-0000-0000-0000-000000000000",
          patient_name: "Ana Teste",
        }),
      ),
      toolUseTurn(toolUse(TOOL_NAMES.hold, { start: 7 })),
      toolUseTurn(
        toolUse(TOOL_NAMES.escalate, { reason: "x", context: "y" }, "tu_esc"),
        toolUse(
          TOOL_NAMES.availability,
          { from: AGENT_NOW.toISOString(), to: DAY_END, type: "cleaning" },
          "tu_av",
        ),
      ),
    ]);
    await runTurn(llm, "pode marcar qualquer coisa");
    const rejected = tel
      .spans()
      .filter((s) => s.name.startsWith("execute_tool "))
      .map((s) => [
        s.attributes["gen_ai.tool.name"],
        s.attributes["recepia.tool.outcome"],
        s.attributes["recepia.tool.rejected_by"],
      ]);
    expect(rejected).toEqual([
      ["cancel_all_bookings", "rejected", "unknown_tool"],
      [TOOL_NAMES.hold, "rejected", "not_offered"],
      [TOOL_NAMES.confirm, "rejected", "foreign_hold"],
      [TOOL_NAMES.hold, "rejected", "invalid_args"],
      [TOOL_NAMES.escalate, "ok", undefined],
      [TOOL_NAMES.availability, "rejected", "after_handoff"],
    ]);
  });

  it("006 gates are recorded: not_surfaced and confirmation_required (FR-610)", async () => {
    const h = makeAgent(pool, new FakeLLM([]));
    await recordConsent(h.deps, PHONE);
    const hold = await holdSlot(
      h.deps,
      { start: new Date(FIRST_SLOT), type: "cleaning" },
      { phone: PHONE },
    );
    const { booking } = await confirmBooking(h.deps, hold.id, { phone: PHONE, name: "Ana Teste" });
    h.deps.llm = new FakeLLM([
      toolUseTurn(toolUse(TOOL_NAMES.cancelBooking, { booking_id: booking.id }, "tu_ns")),
      toolUseTurn(toolUse(TOOL_NAMES.findBooking, {}, "tu_find")),
      toolUseTurn(toolUse(TOOL_NAMES.cancelBooking, { booking_id: booking.id }, "tu_cr")),
      finalTurn("Confirma o cancelamento?"),
    ]);
    await withSpan("test.root", {}, () =>
      handleInbound(h.deps, { phone: PHONE, text: "cancela", providerMessageId: "m-006" }),
    );
    const outcomes = tel
      .spans()
      .filter((s) => s.name.startsWith("execute_tool "))
      .map((s) => [s.attributes["gen_ai.tool.name"], s.attributes["recepia.tool.rejected_by"]]);
    expect(outcomes).toEqual([
      [TOOL_NAMES.cancelBooking, "not_surfaced"],
      [TOOL_NAMES.findBooking, undefined],
      [TOOL_NAMES.cancelBooking, "confirmation_required"],
    ]);
  });

  it("a confirm without consent is recorded as rejected_by consent", async () => {
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
          toolUse(TOOL_NAMES.confirm, {
            hold_id: lastHoldId(i.messages),
            patient_name: "Ana Teste",
          }),
        ),
      finalTurn("Preciso da sua autorização."),
    ]);
    await runTurn(llm, "quero marcar", false);
    const confirm = tel.spans().find((s) => s.name === `execute_tool ${TOOL_NAMES.confirm}`);
    expect(confirm?.attributes).toMatchObject({
      "recepia.tool.outcome": "rejected",
      "recepia.tool.rejected_by": "consent",
    });
  });

  it("a tool that throws a domain error is recorded as outcome error with its type", async () => {
    const h = makeAgent(pool, new FakeLLM([]));
    await recordConsent(h.deps, PHONE);
    h.calendar.failAlways = true; // confirm_booking escalates after the calendar retries
    h.deps.llm = new FakeLLM([
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
          toolUse(TOOL_NAMES.confirm, {
            hold_id: lastHoldId(i.messages),
            patient_name: "Ana Teste",
          }),
        ),
    ]);
    await withSpan("test.root", {}, () =>
      handleInbound(h.deps, { phone: PHONE, text: "quero marcar", providerMessageId: "m-err" }),
    );
    const confirm = tel.spans().find((s) => s.name === `execute_tool ${TOOL_NAMES.confirm}`);
    expect(confirm?.attributes).toMatchObject({
      "recepia.tool.outcome": "error",
      "error.type": "CalendarWriteError",
    });
  });
});
