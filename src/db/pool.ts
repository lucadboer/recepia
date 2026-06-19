import pg from "pg";

export type { Pool, PoolClient } from "pg";

export function makePool(connectionString: string | undefined = process.env.DATABASE_URL): pg.Pool {
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  return new pg.Pool({ connectionString, max: 20 });
}
