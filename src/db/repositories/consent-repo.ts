import type { Pool, PoolClient } from "../pool.ts";

type Queryable = Pool | PoolClient;

export type ConsentState = "opted_in" | "opted_out";

/** Latest consent state for a phone (most recent `seq`), or null if never recorded. */
export async function latestConsent(q: Queryable, phone: string): Promise<ConsentState | null> {
  const { rows } = await q.query(
    "SELECT state FROM patient_consent WHERE phone = $1 ORDER BY seq DESC LIMIT 1",
    [phone],
  );
  return rows[0] ? (rows[0].state as ConsentState) : null;
}

export async function insertConsent(
  q: Queryable,
  phone: string,
  state: ConsentState,
  source: string,
): Promise<void> {
  await q.query("INSERT INTO patient_consent (phone, state, source) VALUES ($1, $2, $3)", [
    phone,
    state,
    source,
  ]);
}
