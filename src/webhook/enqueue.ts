// 008: the webhook's only business action — store a verified message durably, then let the
// worker know. A throw propagates to the webhook, which answers 503 so the provider retries.

import type { InboundMessage } from "../agent/types";
import { INBOUND_PHONE_MAX_PENDING } from "../config";
import type { Pool } from "../db/pool";
import { insertInbound } from "../db/repositories/inbound-repo";
import type { Clock } from "../ports/clock";
import { log } from "../telemetry/logger";
import { messageRef, patientRef } from "../telemetry/pseudonym";
import type { InboundChannel } from "./server";

export interface DurableEnqueueOptions {
  pool: Pool;
  clock: Clock;
  /** Called after a message was stored (wakes the worker). */
  onStored?: () => void;
  maxPending?: number;
}

export function createDurableEnqueue(
  opts: DurableEnqueueOptions,
): (msg: InboundMessage, channel: InboundChannel) => Promise<void> {
  const maxPending = opts.maxPending ?? INBOUND_PHONE_MAX_PENDING;
  return async (msg, channel) => {
    const client = await opts.pool.connect();
    let outcome: Awaited<ReturnType<typeof insertInbound>>;
    try {
      await client.query("BEGIN");
      outcome = await insertInbound(client, msg, channel, opts.clock.now(), maxPending);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    if (outcome === "dropped") {
      log.warn(
        {
          event: "inbound.flood_dropped",
          channel,
          messageRef: messageRef(msg.providerMessageId),
          patient: patientRef(msg.phone),
        },
        "too many unfinished messages for this phone; message stored as dropped",
      );
      return;
    }
    if (outcome === "inserted") opts.onStored?.();
  };
}
