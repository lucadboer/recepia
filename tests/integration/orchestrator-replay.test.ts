import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeConversationStore } from "../../src/adapters/fakes/fake-conversation-store";
import { FakeLLM, finalTurn, toolUse, toolUseTurn } from "../../src/adapters/fakes/fake-llm";
import { recordConsent } from "../../src/agent/consent";
import { handleInbound } from "../../src/agent/orchestrator";
import { TOOL_NAMES } from "../../src/agent/tool-schemas";
import type { ConversationState } from "../../src/agent/types";
import type { Pool } from "../../src/db/pool";
import { AGENT_NOW, DAY_END, lastHoldId, makeAgent } from "../helpers/agent";
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
    expect((await store.load(PHONE))?.processedInboundIds).toContain("REPLAY-1");
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

  it("a replay of a message that only escalated does not notify reception twice", async () => {
    const h = makeAgent(pool, new FakeLLM([]));
    const store = new DyingStore();
    h.deps.conversations = store;
    const msg = { phone: PHONE, text: "estou com muita dor", providerMessageId: "REPLAY-2" };
    await expect(handleInbound(h.deps, msg)).rejects.toThrow(/killed/);
    await handleInbound(h.deps, msg);
    expect(await countAudit(pool, "escalated")).toBe(1);
  });
});
