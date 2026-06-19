import { MessagingSendError, NotConfigured } from "../../domain/errors";
import type { MessagingPort } from "../../ports/messaging-port";

/**
 * Narrow structural type for the fetch we need. Decouples the adapter from DOM lib
 * types (tsconfig uses lib ES2022 only) and makes it trivial to fake in unit tests.
 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Evolution API v2 outbound adapter (dev/demo WhatsApp). Sends plain text via
 * `POST {baseUrl}/message/sendText/{instance}` with the `apikey` header and body
 * `{ number, text }`. The recipient `number` is the international phone in digits
 * only — Evolution rejects '+' and JID suffixes. fail-fast NotConfigured without creds.
 * https://doc.evolution-api.com/v2/api-reference/message-controller/send-text
 */
export class EvolutionMessaging implements MessagingPort {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly instance: string;
  private readonly fetchFn: FetchLike;

  constructor(
    baseUrl = process.env.EVOLUTION_BASE_URL,
    apiKey = process.env.EVOLUTION_API_KEY,
    instance = process.env.EVOLUTION_INSTANCE,
    fetchFn?: FetchLike,
  ) {
    if (!baseUrl || !apiKey || !instance) {
      throw new NotConfigured(
        "EvolutionMessaging: EVOLUTION_BASE_URL/INSTANCE/API_KEY not set (NEEDS-USER)",
      );
    }
    this.baseUrl = baseUrl.replace(/\/+$/, ""); // tolerate a trailing slash in the base URL
    this.apiKey = apiKey;
    this.instance = instance;
    this.fetchFn = fetchFn ?? (globalThis.fetch as unknown as FetchLike);
  }

  async sendMessage(to: string, body: string): Promise<void> {
    const number = to.replace(/\D/g, ""); // digits only — no '+' or @s.whatsapp.net
    const url = `${this.baseUrl}/message/sendText/${this.instance}`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: this.apiKey },
      body: JSON.stringify({ number, text: body }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new MessagingSendError(
        `EvolutionMessaging.sendMessage failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`,
      );
    }
  }
}
