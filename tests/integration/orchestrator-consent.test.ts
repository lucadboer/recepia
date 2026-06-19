import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeLLM, finalTurn, toolUse, toolUseTurn } from "../../src/adapters/fakes/fake-llm";
import { handleInbound } from "../../src/agent/orchestrator";
import { TOOL_NAMES } from "../../src/agent/tool-schemas";
import type { InboundMessage } from "../../src/agent/types";
import type { Pool } from "../../src/db/pool";
import { AGENT_NOW, DAY_END, lastHoldId, makeAgent } from "../helpers/agent";
import { countAudit, ensureSchema, resetDb, seedRule, testPool } from "../helpers/db";

const PHONE = "+55pac";
const FIRST_SLOT = "2026-06-15T14:00:00.000Z";

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

function inbound(text: string, id: string): InboundMessage {
  return { phone: PHONE, text, providerMessageId: id };
}
async function heldCount(): Promise<number> {
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM booking WHERE patient_phone = $1 AND status = 'held'",
    [PHONE],
  );
  return rows[0].n;
}

describe("orchestrator — consent gate (LGPD)", () => {
  it("blocks confirm until opt-in, then confirms after the patient authorizes", async () => {
    // Turn 1: availability -> hold -> confirm (blocked: no consent) -> asks for opt-in.
    const llm1 = new FakeLLM([
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
      finalTurn("Para confirmar, preciso da sua autorização (LGPD)."),
    ]);
    const h = makeAgent(pool, llm1);

    await handleInbound(h.deps, inbound("quero marcar uma limpeza", "c1"));

    expect(h.calendar.createdCount).toBe(0); // confirm blocked — no consent
    expect(await heldCount()).toBe(1); // but the hold exists
    const saved = await h.conversations.load(PHONE);
    expect(saved?.awaitingConsent).toBe(true);

    // Turn 2: patient authorizes -> consent recorded -> confirm succeeds.
    h.deps.llm = new FakeLLM([
      (i) =>
        toolUseTurn(
          toolUse(TOOL_NAMES.confirm, { hold_id: lastHoldId(i.messages), patient_name: "João" }),
        ),
      finalTurn("Confirmado!"),
    ]);

    const r2 = await handleInbound(h.deps, inbound("sim, autorizo", "c2"));

    expect(r2.status).toBe("replied");
    expect(h.calendar.createdCount).toBe(1); // confirmed after consent
    expect(await countAudit(pool, "consent_recorded")).toBe(1);
    expect(await countAudit(pool, "booking_confirmed")).toBe(1);
  });
});
