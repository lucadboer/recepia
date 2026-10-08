import pg from "pg";
import { DB_LOCK_TIMEOUT_MS } from "../config.ts";

export type { Pool, PoolClient } from "pg";

export interface PoolOptions {
  /** Longest any statement waits for a lock before failing (Postgres `lock_timeout`). */
  lockTimeoutMs?: number;
}

/**
 * Every connection bounds its lock waits (008 review): a transaction stuck behind another — e.g.
 * a timed-out turn's fenced save, which holds its inbound message row — fails and rolls back
 * instead of holding its own locks indefinitely.
 */
export function makePool(
  connectionString: string | undefined = process.env.DATABASE_URL,
  { lockTimeoutMs = DB_LOCK_TIMEOUT_MS }: PoolOptions = {},
): pg.Pool {
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  return new pg.Pool({ connectionString, max: 20, lock_timeout: lockTimeoutMs });
}
