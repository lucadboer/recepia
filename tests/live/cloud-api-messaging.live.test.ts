import { describe, expect, it } from "vitest";
import { CloudApiMessaging } from "../../src/adapters/messaging/cloud-api-messaging";

// LIVE smoke test — sends ONE real WhatsApp message via the Meta Cloud API to the
// test recipient. Out of the default `pnpm test`. Run with:
//   LIVE_CLOUD=1 pnpm test:live
// Requires in .env: WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_TOKEN (and the recipient,
// LIVE_E2E_PATIENT_PHONE, registered as a test recipient in the Meta dashboard).
// NOTE (Meta 24h window): the recipient must have messaged the test number within the
// last 24h, otherwise free-form text is rejected and only templates would deliver.
const live = process.env.LIVE_CLOUD === "1";

describe.skipIf(!live)("CloudApiMessaging — LIVE smoke test", () => {
  it("sends a real text message to the test recipient", async () => {
    const to = process.env.LIVE_E2E_PATIENT_PHONE;
    if (!to) throw new Error("LIVE_E2E_PATIENT_PHONE not set (NEEDS-USER)");

    const messaging = new CloudApiMessaging();
    // Resolves (void) on success; throws MessagingSendError on a non-2xx response.
    await expect(
      messaging.sendMessage(to, "recepia: teste do Cloud API ✅"),
    ).resolves.toBeUndefined();
  });
});
