import { NotConfigured } from "../../domain/errors";
import type { MessagingPort } from "../../ports/messaging-port";

/**
 * WhatsApp Cloud API outbound adapter (pilot) — SCAFFOLD. NEEDS-USER:
 * WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_TOKEN (+ app secret for inbound signature checks).
 */
export class CloudApiMessaging implements MessagingPort {
  constructor(
    phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID,
    token = process.env.WHATSAPP_TOKEN,
  ) {
    if (!phoneNumberId || !token) {
      throw new NotConfigured(
        "CloudApiMessaging: WHATSAPP_PHONE_NUMBER_ID/TOKEN not set (NEEDS-USER)",
      );
    }
  }

  async sendMessage(_to: string, _body: string): Promise<void> {
    // NEEDS-CREDS BOUNDARY — POST https://graph.facebook.com/v20.0/{phoneNumberId}/messages.
    throw new NotConfigured("CloudApiMessaging: live call not wired (NEEDS-USER)");
  }
}
