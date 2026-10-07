// `pnpm retention:purge [--dry-run] [--days N]` — run the LGPD retention purge by hand
// (it also runs daily inside the service). Prints counts only.

import { fileURLToPath } from "node:url";
import { loadEnv } from "../db/env";
import { makePool } from "../db/pool";
import { purgeInactive, RETENTION_DAYS } from "../jobs/retention";

export interface RetentionArgs {
  dryRun: boolean;
  olderThanDays: number;
}

export function parseRetentionArgs(argv: string[]): RetentionArgs {
  const out: RetentionArgs = { dryRun: false, olderThanDays: RETENTION_DAYS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--days") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) throw new Error("--days expects a positive integer");
      out.olderThanDays = n;
    } else throw new Error(`unknown argument "${a}"`);
  }
  return out;
}

const isEntrypoint =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  loadEnv();
  let args: RetentionArgs;
  try {
    args = parseRetentionArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${(err as Error).message}\nusage: pnpm retention:purge [--dry-run] [--days N]`);
    process.exit(2);
  }
  const pool = makePool();
  purgeInactive(pool, new Date(), args)
    .then((r) => {
      console.log(
        `${r.dryRun ? "[dry run] would purge" : "purged"} ${r.conversationStates} conversation state(s) and ${r.outboxMessages} outbox message(s) older than ${r.olderThanDays} days (cutoff ${r.cutoff})`,
      );
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
