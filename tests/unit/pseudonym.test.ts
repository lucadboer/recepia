import { afterEach, describe, expect, it, vi } from "vitest";
import {
  maskPhone,
  maskPhonesIn,
  patientPseudonym,
  patientRef,
  resetPseudonymKey,
  usingRandomPseudonymKey,
} from "../../src/telemetry/pseudonym";

// T503 — patients are identified in telemetry by a masked phone and a keyed pseudonym (FR-505).

const PHONE = "+5531900000101";

afterEach(() => {
  vi.unstubAllEnvs();
  resetPseudonymKey();
});

describe("maskPhone", () => {
  it("keeps only the last 4 digits", () => {
    expect(maskPhone(PHONE)).toBe("***0101");
    expect(maskPhone("553199998888@s.whatsapp.net")).toBe("***8888");
    expect(maskPhone("+55 (31) 9 9999-8888")).toBe("***8888");
  });

  it("reveals nothing for inputs with fewer than 5 digits", () => {
    expect(maskPhone("123")).toBe("***");
    expect(maskPhone("")).toBe("***");
    expect(maskPhone("1234")).toBe("***");
  });
});

describe("maskPhonesIn (backstop for free text)", () => {
  it("masks every 10–15 digit run, with or without +, and leaves other text alone", () => {
    expect(maskPhonesIn(`conflict for ${PHONE} at version 3`)).toBe(
      "conflict for ***0101 at version 3",
    );
    expect(maskPhonesIn("jid 553199998888@s.whatsapp.net ok")).toBe(
      "jid ***8888@s.whatsapp.net ok",
    );
    expect(maskPhonesIn("short 12345 and 2026-06-15")).toBe("short 12345 and 2026-06-15");
  });
});

describe("patientPseudonym", () => {
  it("is stable for the same key, differs across keys and never contains the phone", () => {
    vi.stubEnv("TELEMETRY_HASH_KEY", "key-a");
    resetPseudonymKey();
    const a1 = patientPseudonym(PHONE);
    const a2 = patientPseudonym(PHONE);
    expect(a1).toBe(a2);
    expect(a1).toMatch(/^[0-9a-f]{16}$/);
    expect(a1).not.toContain("0101");
    expect(patientPseudonym("+5531900000102")).not.toBe(a1);
    vi.stubEnv("TELEMETRY_HASH_KEY", "key-b");
    resetPseudonymKey();
    expect(patientPseudonym(PHONE)).not.toBe(a1);
    expect(usingRandomPseudonymKey()).toBe(false);
  });

  it("uses a random per-process key when TELEMETRY_HASH_KEY is absent (and says so)", () => {
    vi.stubEnv("TELEMETRY_HASH_KEY", "");
    resetPseudonymKey();
    const first = patientPseudonym(PHONE);
    expect(patientPseudonym(PHONE)).toBe(first); // stable within the process
    expect(usingRandomPseudonymKey()).toBe(true);
    resetPseudonymKey();
    expect(patientPseudonym(PHONE)).not.toBe(first); // a new process → new pseudonyms
  });

  it("patientRef bundles both forms", () => {
    vi.stubEnv("TELEMETRY_HASH_KEY", "key-a");
    resetPseudonymKey();
    expect(patientRef(PHONE)).toEqual({ id: patientPseudonym(PHONE), phoneMasked: "***0101" });
  });
});
