/** Single time source — injected so TTL/horizon/expiry are deterministic in tests. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
