import { describe, expect, it } from "vitest";
import { chaosVerdict } from "../../scripts/inbound-chaos";

// T812 (008) — the chaos run is only as good as its verdict: every invariant must fail it.

const ok = {
  acknowledged: 60,
  done: 60,
  lost: [],
  stuck: 0,
  overbookedSlots: 0,
  duplicatePatients: 0,
  confirmedPatients: 60,
};

describe("chaosVerdict", () => {
  it("passes only when nothing was lost, stuck, overbooked or duplicated", () => {
    expect(chaosVerdict(ok).pass).toBe(true);
    expect(chaosVerdict({ ...ok, lost: ["m1"] }).pass).toBe(false);
    expect(chaosVerdict({ ...ok, stuck: 1 }).pass).toBe(false);
    expect(chaosVerdict({ ...ok, overbookedSlots: 1 }).pass).toBe(false);
    expect(chaosVerdict({ ...ok, duplicatePatients: 1 }).pass).toBe(false);
  });

  it("fails a run in which bookings did not actually happen (the other checks would pass vacuously)", () => {
    expect(chaosVerdict({ ...ok, confirmedPatients: 0 }).pass).toBe(false);
    expect(chaosVerdict({ ...ok, confirmedPatients: 29 }).pass).toBe(false);
    expect(chaosVerdict({ ...ok, confirmedPatients: 30 }).pass).toBe(true);
  });
});
