/**
 * In-process serialization per key (the patient phone): tasks for the same key run
 * strictly one after another; tasks for different keys overlap. Used by the webhook so
 * two quick messages from one patient never race the same conversation state (T240).
 * Cross-process safety is the DB's compare-and-swap (`conversation_state.version`).
 */
export class PerKeyQueue {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly settlements = new Set<Promise<void>>();
  private pending = 0;

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    // A rejected predecessor must not block the successor.
    const next: Promise<T> = prev.catch(() => undefined).then(() => fn());
    this.tails.set(key, next);
    this.pending++;
    const settled: Promise<void> = next
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.pending--;
        this.settlements.delete(settled);
        if (this.tails.get(key) === next) this.tails.delete(key);
      });
    this.settlements.add(settled);
    return next;
  }

  /** Running + queued tasks. */
  get inFlight(): number {
    return this.pending;
  }

  /** Resolve true once everything (including work added meanwhile) settled; false on timeout. */
  async drain(timeoutMs: number): Promise<boolean> {
    let timedOut = false;
    const timeout = new Promise<false>((resolve) => {
      const t = setTimeout(() => {
        timedOut = true;
        resolve(false);
      }, timeoutMs);
      t.unref?.();
    });
    while (this.pending > 0 && !timedOut) {
      await Promise.race([Promise.all([...this.settlements]), timeout]);
    }
    return this.pending === 0;
  }
}
