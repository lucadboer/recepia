// Patient identity in telemetry (FR-505): never the phone. A masked form for humans (last 4
// digits) and a keyed pseudonym for correlation that cannot be reversed without the operator's
// secret (TELEMETRY_HASH_KEY). Without the secret, a random per-process key is used — pseudonyms
// then change on restart; the service logs a warning at startup (usingRandomPseudonymKey()).

import { createHmac, randomBytes } from "node:crypto";

let key: Buffer | null = null;
let randomKey = false;

function hashKey(): Buffer {
  if (key) return key;
  const configured = process.env.TELEMETRY_HASH_KEY;
  if (configured && configured.length > 0) {
    key = Buffer.from(configured, "utf8");
    randomKey = false;
  } else {
    key = randomBytes(32);
    randomKey = true;
  }
  return key;
}

/** Test seam / key rotation: the next pseudonym re-reads TELEMETRY_HASH_KEY. */
export function resetPseudonymKey(): void {
  key = null;
  randomKey = false;
}

/** True when no TELEMETRY_HASH_KEY was configured (pseudonyms are per-process only). */
export function usingRandomPseudonymKey(): boolean {
  hashKey();
  return randomKey;
}

/** `***NNNN` — the last 4 digits; nothing when fewer than 5 digits exist. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length > 4 ? `***${digits.slice(-4)}` : "***";
}

/** Backstop for free text (error messages, third-party strings): masks every 10–15 digit run. */
export function maskPhonesIn(text: string): string {
  return text.replace(/\+?\d{10,15}/g, (m) => maskPhone(m));
}

/** First 16 hex chars of HMAC-SHA256(phone, key). */
export function patientPseudonym(phone: string): string {
  return createHmac("sha256", hashKey()).update(phone).digest("hex").slice(0, 16);
}

export interface PatientRef {
  id: string;
  phoneMasked: string;
}

export function patientRef(phone: string): PatientRef {
  return { id: patientPseudonym(phone), phoneMasked: maskPhone(phone) };
}
