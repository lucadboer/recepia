import type { Pool } from "../../src/db/pool";

type AnyQuery = (...a: unknown[]) => unknown;

export interface InterceptOptions {
  /** Return an Error to reject that statement instead of running it. */
  reject?: (sql: string) => Error | null | undefined;
  /** Runs before every statement that is not rejected (e.g. to race another writer). */
  before?: (sql: string) => Promise<void> | void;
}

export function sqlOf(args: unknown[]): string {
  return typeof args[0] === "string" ? args[0] : ((args[0] as { text?: string })?.text ?? "");
}

/**
 * Wraps the real pool so that clients checked out through it run every statement through
 * `reject` / `before` first. The patched `query` is RESTORED on `release`, so the physical
 * client goes back to the pool clean and later tests never inherit the interception.
 */
export function interceptingPool(real: Pool, opts: InterceptOptions): Pool {
  return {
    query: (...args: unknown[]) => (real as unknown as { query: AnyQuery }).query(...args),
    async connect() {
      const client = await real.connect();
      const mutable = client as unknown as { query: AnyQuery; release: AnyQuery };
      const origQuery = mutable.query.bind(client);
      const origRelease = mutable.release.bind(client);
      mutable.query = async (...args: unknown[]) => {
        const sql = sqlOf(args);
        const err = opts.reject?.(sql);
        if (err) throw err;
        await opts.before?.(sql);
        return origQuery(...args);
      };
      mutable.release = (...args: unknown[]) => {
        mutable.query = origQuery;
        mutable.release = origRelease;
        return origRelease(...args);
      };
      return client;
    },
  } as unknown as Pool;
}
