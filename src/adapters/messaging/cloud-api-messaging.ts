import { MessagingSendError, NotConfigured } from "../../domain/errors";
import type { MessageTemplate, MessagingPort } from "../../ports/messaging-port";
import { maskPhonesIn } from "../../telemetry/pseudonym";

/**
 * Narrow structural fetch type — decouples from DOM lib types and is trivial to fake.
 * (Same shape used by EvolutionMessaging.)
 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const DEFAULT_VERSION = "v23.0";

/**
 * WhatsApp Cloud API (Meta) outbound adapter. Sends plain text via
 * `POST https://graph.facebook.com/{version}/{phoneNumberId}/messages` with a Bearer
 * token. The recipient `to` is the international phone in digits only (no '+').
 * NOTE (Meta 24h window): free-form text only delivers within 24h of the user's last
 * inbound message; outside that window only approved templates send. fail-fast without creds.
 * https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 */
export class CloudApiMessaging implements MessagingPort {
  private readonly phoneNumberId: string;
  private readonly token: string;
  private readonly version: string;
  private readonly fetchFn: FetchLike;

  constructor(
    phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID,
    token = process.env.WHATSAPP_TOKEN,
    version = process.env.WHATSAPP_API_VERSION,
    fetchFn?: FetchLike,
  ) {
    if (!phoneNumberId || !token) {
      throw new NotConfigured(
        "CloudApiMessaging: WHATSAPP_PHONE_NUMBER_ID/TOKEN not set (NEEDS-USER)",
      );
    }
    this.phoneNumberId = phoneNumberId;
    this.token = token;
    this.version = version && version.length > 0 ? version : DEFAULT_VERSION;
    this.fetchFn = fetchFn ?? (globalThis.fetch as unknown as FetchLike);
  }

  async sendMessage(to: string, body: string, template?: MessageTemplate): Promise<void> {
    const recipient = to.replace(/\D/g, ""); // digits only — no '+' or JID
    const url = `https://graph.facebook.com/${this.version}/${this.phoneNumberId}/messages`;
    // A business-initiated message outside the 24h window must be an approved template (007).
    const content = template
      ? {
          type: "template",
          template: {
            name: template.name,
            language: { code: template.language },
            components: [
              {
                type: "body",
                parameters: template.params.map((p) => ({
                  type: "text",
                  text: p.replace(/[\n\t\r]+/g, " ").replace(/ {2,}/g, " "),
                })),
              },
            ],
          },
        }
      : { type: "text", text: { preview_url: false, body } };
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient,
        ...content,
      }),
    });
    if (!res.ok) {
      // Provider bodies can echo the recipient (number / JID): masked and truncated (FR-505).
      const detail = maskPhonesIn(await res.text().catch(() => "")).slice(0, 300);
      throw new MessagingSendError(
        `CloudApiMessaging.sendMessage failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`,
      );
    }
  }
}
