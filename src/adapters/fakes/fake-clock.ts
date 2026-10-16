import type { Clock } from "../../ports/clock.ts";

/** Controllable clock for deterministic tests. */
export class FakeClock implements Clock {
  private current: Date;

  constructor(start: Date) {
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  set(value: Date): void {
    this.current = new Date(value);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
