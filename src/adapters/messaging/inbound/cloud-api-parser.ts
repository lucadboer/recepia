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

/** A delivery-status event from a Cloud API webhook (sent/delivered/read/failed). */
export interface CloudStatus {
  id: string;
  status: string;
  recipientId?: string;
  errors?: { code: number; title?: string }[];
}

interface CloudStatusPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        statuses?: Array<{
          id?: string;
          status?: string;
          recipient_id?: string;
          errors?: Array<{ code?: number; title?: string }>;
        }>;
      };
    }>;
  }>;
}

/**
 * Parse a Cloud API webhook's `value.statuses[]` (delivery receipts) — kept SEPARATE
 * from `parseCloudApiInbound` (patient messages). Statuses are for observability/logging
 * only and must NEVER be routed to the orchestrator.
 */
export function parseCloudApiStatuses(payload: unknown): CloudStatus[] {
  const p = payload as CloudStatusPayload;
  const out: CloudStatus[] = [];
  for (const entry of p.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const s of change.value?.statuses ?? []) {
        if (!s.id || !s.status) continue;
        const errors = s.errors
          ?.filter((e): e is { code: number; title?: string } => typeof e.code === "number")
          .map((e) => ({ code: e.code, title: e.title }));
        out.push({ id: s.id, status: s.status, recipientId: s.recipient_id, errors });
      }
    }
  }
  return out;
}
