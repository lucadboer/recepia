import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  appendUserText,
  emptyState,
  markEscalated,
  markProcessed,
} from "../../src/agent/conversation";
import { releaseConversation } from "../../src/cli/conversation-release";
import type { Pool } from "../../src/db/pool";
import { DbConversationStore } from "../../src/db/repositories/conversation-repo";
import { countAudit, ensureSchema, resetDb, testPool } from "../helpers/db";

const NOW = new Date("2026-06-15T12:00:00Z");
const LATER = new Date("2026-06-15T13:00:00Z");
const PHONE = "+55a";

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

describe("releaseConversation — reception releases a handed-off conversation (T237)", () => {
  it("resets an escalated conversation to a fresh active state and audits it (actor human)", async () => {
    const store = new DbConversationStore(pool);
    let s = emptyState(PHONE, NOW);
    s = appendUserText(s, "estou com dor", NOW);
    s = markProcessed(s, "m1", NOW);
    s = markEscalated(s, NOW);
    await store.save(s);

    expect(await releaseConversation(pool, PHONE, LATER)).toBe(true);

    const loaded = await store.load(PHONE);
    expect(loaded?.status).toBe("active");
    expect(loaded?.history).toEqual([]);
    expect(loaded?.escalatedAt).toBeNull();
    expect(loaded?.handoffNoticeAt).toBeNull();
    expect(loaded?.processedInboundIds).toEqual(["m1"]); // dedupe kept
    expect(await countAudit(pool, "conversation_released")).toBe(1);
    const audit = await pool.query(
      "SELECT actor, payload FROM audit_log WHERE action = 'conversation_released'",
    );
    expect(audit.rows[0].actor).toBe("human");
    expect(audit.rows[0].payload.phone).toBe(PHONE);
  });

  it("is a no-op for an active conversation and for an unknown phone", async () => {
    const store = new DbConversationStore(pool);
    const s = appendUserText(emptyState(PHONE, NOW), "oi", NOW);
    await store.save(s);

    expect(await releaseConversation(pool, PHONE, LATER)).toBe(false);
    expect(await releaseConversation(pool, "+55nobody", LATER)).toBe(false);

    const loaded = await store.load(PHONE);
    expect(loaded?.history).toHaveLength(1); // untouched
    expect(await countAudit(pool, "conversation_released")).toBe(0);
  });
});
