import { NotConfigured } from "../../domain/errors";
import type { MessagingPort } from "../../ports/messaging-port";

/**
 * Evolution API outbound adapter (dev/demo) — SCAFFOLD. NEEDS-USER:
 * EVOLUTION_API_URL, EVOLUTION_API_KEY, EVOLUTION_INSTANCE.
 */
export class EvolutionMessaging implements MessagingPort {
  constructor(
    baseUrl = process.env.EVOLUTION_API_URL,
    apiKey = process.env.EVOLUTION_API_KEY,
    instance = process.env.EVOLUTION_INSTANCE,
  ) {
    if (!baseUrl || !apiKey || !instance) {
      throw new NotConfigured(
        "EvolutionMessaging: EVOLUTION_API_URL/KEY/INSTANCE not set (NEEDS-USER)",
      );
    }
  }

  async sendMessage(_to: string, _body: string): Promise<void> {
    // NEEDS-CREDS BOUNDARY — POST {baseUrl}/message/sendText/{instance} with the apikey header.
    throw new NotConfigured("EvolutionMessaging: live call not wired (NEEDS-USER)");
  }
}
