import type { MessagingPort } from "../../ports/messaging-port";

/** In-memory MessagingPort that records every sent message. */
export class FakeMessaging implements MessagingPort {
  readonly sent: Array<{ to: string; body: string }> = [];

  async sendMessage(to: string, body: string): Promise<void> {
    this.sent.push({ to, body });
  }
}
