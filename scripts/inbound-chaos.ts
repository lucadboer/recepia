// 008 chaos test (FR-810): run the production inbound path in a child process, SIGKILL it at random
// moments three times while patients keep writing, restart it, and prove that every acknowledged
// message was processed, nothing is stuck, no time is overbooked and no patient has two bookings.
//
//   pnpm chaos:inbound            (CHAOS_PHONES, CHAOS_KILLS, CHAOS_SEED tune the run)

import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { recordConsent } from "../src/agent/consent";
import { assertDisposableDatabase } from "../src/db/disposable";
import { loadEnv } from "../src/db/env";
import { migrate } from "../src/db/migrate";
import { makePool, type Pool } from "../src/db/pool";

const SECRET = "chaos-secret";
const CAPACITY = 2;

export interface ChaosInvariants {
  acknowledged: number;
  done: number;
  lost: string[];
  stuck: number;
  overbookedSlots: number;
  duplicatePatients: number;
  pass: boolean;
}

/** Pure verdict over what the database says — unit-tested. */
export function chaosVerdict(r: Omit<ChaosInvariants, "pass">): ChaosInvariants {
  const pass =
    r.lost.length === 0 && r.stuck === 0 && r.overbookedSlots === 0 && r.duplicatePatients === 0;
  return { ...r, pass };
}

/** Deterministic PRNG so a failing run can be replayed with the same CHAOS_SEED. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function startChild(): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/chaos-server.ts"], {
    env: { ...process.env, CHAOS_SECRET: SECRET },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    let buf = "";
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      const m = /READY (\d+)/.exec(buf);
      if (m) resolve({ child, port: Number(m[1]) });
    });
    child.on("exit", (code) => reject(new Error(`chaos server exited early (${code})`)));
  });
}

async function resetAndSeed(pool: Pool, phones: string[]): Promise<void> {
  await migrate(pool);
  const client = await pool.connect();
  try {
    await client.query("ALTER TABLE audit_log DISABLE TRIGGER USER");
    await client.query(
      "TRUNCATE booking, audit_log, capacity_rule, capacity_override, patient_consent, conversation_state, outbox_message, inbound_message RESTART IDENTITY",
    );
  } finally {
    await client.query("ALTER TABLE audit_log ENABLE TRIGGER USER").catch(() => {});
    client.release();
  }
  for (let wd = 0; wd <= 6; wd++) {
    await pool.query(
      "INSERT INTO capacity_rule (weekday, start_time, end_time, capacity) VALUES ($1, '09:00', '18:00', $2)",
      [wd, CAPACITY],
    );
  }
  const deps = { pool } as Parameters<typeof recordConsent>[0];
  for (const p of phones) await recordConsent(deps, p);
}

async function post(port: number, phone: string, id: string, text: string): Promise<number> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/webhook/evolution/${SECRET}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: SECRET },
      body: JSON.stringify({
        event: "messages.upsert",
        data: {
          key: { remoteJid: `${phone.slice(1)}@s.whatsapp.net`, fromMe: false, id },
          message: { conversation: text },
        },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    return res.status;
  } catch {
    return 0; // connection refused / reset: the child was killed — not acknowledged
  }
}

async function main(): Promise<void> {
  loadEnv();
  assertDisposableDatabase(process.env.DATABASE_URL);
  const phonesCount = Number(process.env.CHAOS_PHONES ?? 60);
  const kills = Number(process.env.CHAOS_KILLS ?? 3);
  const random = rng(Number(process.env.CHAOS_SEED ?? 8));
  const phones = Array.from(
    { length: phonesCount },
    (_, i) => `+55319001${String(i).padStart(5, "0")}`,
  );
  const pool = makePool();
  await resetAndSeed(pool, phones);

  let current = await startChild();
  const acknowledged: string[] = [];
  let killsDone = 0;
  // One booking request per phone: if a killed turn were re-run after its booking committed, the
  // patient would end up with two bookings — exactly what the duplicate check below catches.
  const queue = phones.map((p, i) => ({
    phone: p,
    id: `${p}-a`,
    text: `quero marcar uma limpeza #${i}`,
  }));
  for (let i = 0; i < queue.length; i++) {
    const m = queue[i];
    const status = await post(current.port, m.phone, m.id, m.text);
    if (status === 200) acknowledged.push(m.id);
    else queue.push(m); // never acknowledged: the provider would retry it later
    if (killsDone < kills && random() < kills / queue.length) {
      current.child.kill("SIGKILL");
      killsDone++;
      console.log(`chaos: SIGKILL #${killsDone} after ${acknowledged.length} acknowledged`);
      await new Promise((r) => setTimeout(r, 50));
      current = await startChild();
    }
  }
  while (killsDone < kills) {
    current.child.kill("SIGKILL");
    killsDone++;
    current = await startChild();
  }

  // Let the last child drain the queue (killed workers' leases expire and are reclaimed).
  const deadline = Date.now() + 60_000;
  for (;;) {
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM inbound_message WHERE status IN ('pending','processing')",
    );
    if (rows[0].n === 0 || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  current.child.kill("SIGTERM");

  const { rows: stored } = await pool.query(
    "SELECT provider_message_id, status FROM inbound_message",
  );
  const byId = new Map(stored.map((r) => [r.provider_message_id as string, r.status as string]));
  const lost = acknowledged.filter((id) => byId.get(id) !== "done");
  const stuck = stored.filter((r) => r.status === "pending" || r.status === "processing").length;
  const over = await pool.query(
    `SELECT start_ts FROM booking WHERE status IN ('confirmed','patient_confirmed','done')
     GROUP BY start_ts HAVING count(*) > $1`,
    [CAPACITY],
  );
  const dup = await pool.query(
    `SELECT patient_phone FROM booking WHERE status IN ('confirmed','patient_confirmed','done')
     GROUP BY patient_phone HAVING count(*) > 1`,
  );
  await pool.end();
  const verdict = chaosVerdict({
    acknowledged: acknowledged.length,
    done: [...byId.values()].filter((s) => s === "done").length,
    lost,
    stuck,
    overbookedSlots: over.rows.length,
    duplicatePatients: dup.rows.length,
  });
  console.log(JSON.stringify({ kills: killsDone, ...verdict }, null, 2));
  if (!verdict.pass) process.exit(1);
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
