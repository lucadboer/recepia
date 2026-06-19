import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "../../src/db/pool";
import { ensureSchema, resetDb, testPool } from "../helpers/db";

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

describe("audit_log is append-only (DB-enforced)", () => {
  it("rejects UPDATE and DELETE but allows INSERT", async () => {
    await pool.query(
      "INSERT INTO audit_log (entity, entity_id, action, actor, payload) VALUES ('booking', NULL, 'escalated', 'ai', '{}')",
    );

    await expect(pool.query("UPDATE audit_log SET action = 'tampered'")).rejects.toThrow(
      /append-only/,
    );
    await expect(pool.query("DELETE FROM audit_log")).rejects.toThrow(/append-only/);
    await expect(pool.query("TRUNCATE audit_log")).rejects.toThrow(/append-only/);

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM audit_log");
    expect(rows[0].n).toBe(1);
  });
});
