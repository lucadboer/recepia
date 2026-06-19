import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  appendUserText,
  emptyState,
  markProcessed,
  recordHold,
  recordOfferedSlots,
} from "../../src/agent/conversation";
import type { Pool } from "../../src/db/pool";
import { DbConversationStore } from "../../src/db/repositories/conversation-repo";
import { ensureSchema, resetDb, testPool } from "../helpers/db";

const NOW = new Date("2026-06-15T12:00:00Z");

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
});

describe("DbConversationStore", () => {
  it("returns null for an unknown phone", async () => {
    const store = new DbConversationStore(pool);
    expect(await store.load("+55unknown")).toBeNull();
  });

  it("round-trips conversation state (save then load)", async () => {
    const store = new DbConversationStore(pool);
    let s = emptyState("+55a", NOW);
    s = appendUserText(s, "quero marcar", NOW);
    s = recordOfferedSlots(s, ["2026-06-15T14:00:00.000Z"], NOW);
    s = recordHold(s, "hold-1", NOW);
    s = markProcessed(s, "m1", NOW);

    await store.save(s);
    const loaded = await store.load("+55a");

    expect(loaded).not.toBeNull();
    expect(loaded?.offeredSlots).toEqual(["2026-06-15T14:00:00.000Z"]);
    expect(loaded?.activeHoldIds).toEqual(["hold-1"]);
    expect(loaded?.processedInboundIds).toEqual(["m1"]);
    expect(loaded?.history).toHaveLength(1);
    expect(loaded?.awaitingConsent).toBe(false);
    expect(loaded?.updatedAt).toBeInstanceOf(Date);
  });

  it("upserts on save (latest state wins)", async () => {
    const store = new DbConversationStore(pool);
    const s0 = emptyState("+55a", NOW);
    await store.save(s0);
    await store.save(recordHold(s0, "hold-2", NOW));
    const loaded = await store.load("+55a");
    expect(loaded?.activeHoldIds).toEqual(["hold-2"]);
  });
});
