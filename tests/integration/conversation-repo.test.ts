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
import { ConversationConflictError } from "../../src/domain/errors";
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

  it("round-trips conversation state (save then load) and stamps version 1", async () => {
    const store = new DbConversationStore(pool);
    let s = emptyState("+55a", NOW);
    s = appendUserText(s, "quero marcar", NOW);
    s = recordOfferedSlots(s, ["2026-06-15T14:00:00.000Z"], NOW);
    s = recordHold(s, "hold-1", NOW);
    s = markProcessed(s, "m1", NOW);

    const saved = await store.save(s);
    expect(saved.version).toBe(1);
    const loaded = await store.load("+55a");

    expect(loaded).not.toBeNull();
    expect(loaded?.version).toBe(1);
    expect(loaded?.offeredSlots).toEqual(["2026-06-15T14:00:00.000Z"]);
    expect(loaded?.activeHoldIds).toEqual(["hold-1"]);
    expect(loaded?.processedInboundIds).toEqual(["m1"]);
    expect(loaded?.history).toHaveLength(1);
    expect(loaded?.awaitingConsent).toBe(false);
    expect(loaded?.updatedAt).toBeInstanceOf(Date);
  });

  it("load → modify → save chains versions (optimistic concurrency, T240)", async () => {
    const store = new DbConversationStore(pool);
    await store.save(emptyState("+55a", NOW)); // v1
    const v1 = await store.load("+55a");
    const saved2 = await store.save(recordHold(v1 as NonNullable<typeof v1>, "hold-2", NOW));
    expect(saved2.version).toBe(2);
    const v2 = await store.load("+55a");
    expect(v2?.version).toBe(2);
    expect(v2?.activeHoldIds).toEqual(["hold-2"]);
  });

  it("a STALE save throws ConversationConflictError and does not overwrite the newer state", async () => {
    const store = new DbConversationStore(pool);
    await store.save(emptyState("+55a", NOW)); // v1
    const a = await store.load("+55a");
    const b = await store.load("+55a");
    await store.save(recordHold(a as NonNullable<typeof a>, "from-a", NOW)); // v2

    await expect(
      store.save(recordHold(b as NonNullable<typeof b>, "from-b", NOW)), // still v1 → stale
    ).rejects.toBeInstanceOf(ConversationConflictError);

    const current = await store.load("+55a");
    expect(current?.version).toBe(2);
    expect(current?.activeHoldIds).toEqual(["from-a"]);
  });

  it("saving a never-persisted (version 0) state when a row already exists is a conflict", async () => {
    const store = new DbConversationStore(pool);
    await store.save(emptyState("+55a", NOW)); // v1
    await expect(store.save(emptyState("+55a", NOW))).rejects.toBeInstanceOf(
      ConversationConflictError,
    );
  });
});

describe("DbConversationStore — promptVersion (004 US3)", async () => {
  const { DbConversationStore } = await import("../../src/db/repositories/conversation-repo");
  const { emptyState } = await import("../../src/agent/conversation");

  it("round-trips promptVersion and reads legacy rows (no field) as null", async () => {
    const store = new DbConversationStore(pool);
    const now = new Date("2026-06-15T12:00:00Z");
    const saved = await store.save({ ...emptyState("+55pv", now), promptVersion: "v001+abcdef0" });
    expect((await store.load("+55pv"))?.promptVersion).toBe("v001+abcdef0");
    // A row written before the field existed.
    const legacy = { ...emptyState("+55legacy", now) } as Record<string, unknown>;
    delete legacy.promptVersion;
    await pool.query(
      "INSERT INTO conversation_state (phone, state, version, updated_at) VALUES ($1, $2, 1, now())",
      ["+55legacy", JSON.stringify(legacy)],
    );
    expect((await store.load("+55legacy"))?.promptVersion).toBeNull();
    expect(saved.version).toBe(1);
  });
});
