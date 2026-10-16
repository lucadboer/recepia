import { MessagingSendError } from "../../domain/errors.ts";
import type { MessageTemplate, MessagingPort } from "../../ports/messaging-port.ts";

/**
 * In-memory MessagingPort that records every sent message. Failure is configurable:
 * - `failTimes`: fail the next N sends (transient outage), then succeed.
 * - `failAlways`: every send fails (persistent outage).
 */
export class FakeMessaging implements MessagingPort {
  /** `template` is recorded only when one was given (007), so plain sends compare as before. */
  readonly sent: Array<{ to: string; body: string; template?: MessageTemplate }> = [];
  attempts = 0;
  failTimes = 0;
  failAlways = false;

  async sendMessage(to: string, body: string, template?: MessageTemplate): Promise<void> {
    this.attempts++;
    if (this.failAlways || this.failTimes > 0) {
      if (this.failTimes > 0) this.failTimes--;
      throw new MessagingSendError("messaging down");
    }
    this.sent.push(template ? { to, body, template } : { to, body });
  }
}
