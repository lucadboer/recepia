import type { InboundMessage } from "../../../agent/types";

// Minimal shape of a WhatsApp Cloud API webhook payload (text only).
interface CloudApiPayload {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{
          from?: string;
          id?: string;
          type?: string;
          text?: { body?: string };
          timestamp?: string;
        }>;
        statuses?: unknown[];
      };
    }>;
  }>;
}

/** Parse a WhatsApp Cloud API webhook into zero or more normalized InboundMessages. */
export function parseCloudApiInbound(payload: unknown): InboundMessage[] {
  const p = payload as CloudApiPayload;
  const out: InboundMessage[] = [];

  for (const entry of p.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const m of change.value?.messages ?? []) {
        if (m.type !== "text") continue; // ignore non-text
        const text = m.text?.body;
        if (!m.from || !m.id || typeof text !== "string" || text.length === 0) continue;
        const receivedAt = m.timestamp ? new Date(Number(m.timestamp) * 1000) : undefined;
        out.push({ phone: `+${m.from}`, text, providerMessageId: m.id, receivedAt });
      }
    }
  }
  return out;
}
