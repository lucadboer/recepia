// LGPD opt-in gate. The deterministic confirm_booking tool stamps consent_at
// unconditionally, so this gate (called by the orchestrator BEFORE confirm) is the
// enforcement point. Consent changes are audited.

import { appendAudit } from "../db/repositories/audit-repo";
import { insertConsent, latestConsent } from "../db/repositories/consent-repo";
import type { Deps } from "../deps";

export async function hasConsent(deps: Deps, phone: string): Promise<boolean> {
  return (await latestConsent(deps.pool, phone)) === "opted_in";
}

export async function recordConsent(
  deps: Deps,
  phone: string,
  source = "whatsapp_optin",
): Promise<void> {
  await writeConsent(deps, phone, "opted_in", source, "consent_recorded");
}

export async function recordOptOut(
  deps: Deps,
  phone: string,
  source = "whatsapp_optout",
): Promise<void> {
  await writeConsent(deps, phone, "opted_out", source, "consent_revoked");
}

async function writeConsent(
  deps: Deps,
  phone: string,
  state: "opted_in" | "opted_out",
  source: string,
  action: "consent_recorded" | "consent_revoked",
): Promise<void> {
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    await insertConsent(client, phone, state, source);
    await appendAudit(client, {
      entity: "consent",
      entityId: null,
      action,
      actor: "ai",
      payload: { phone, source },
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
