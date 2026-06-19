import { loadEnv } from "./env";
import { makePool } from "./pool";
import type { Pool } from "./pool";

/** Demo capacity: Mon–Fri 09:00–18:00, capacity 2. Idempotent (replaces rules). */
export async function seed(pool: Pool = makePool()): Promise<void> {
  await pool.query("TRUNCATE capacity_rule");
  for (let weekday = 1; weekday <= 5; weekday++) {
    await pool.query(
      "INSERT INTO capacity_rule (weekday, start_time, end_time, capacity) VALUES ($1, '09:00', '18:00', 2)",
      [weekday],
    );
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "___");

if (invokedDirectly) {
  loadEnv();
  const pool = makePool();
  seed(pool)
    .then(() => {
      console.log("Seeded demo capacity (Mon–Fri 09:00–18:00, capacity 2)");
      return pool.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
