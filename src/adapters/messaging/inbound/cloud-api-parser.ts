import type { InboundMessage } from "../../../agent/types.ts";

// Minimal shape of a WhatsApp Cloud API webhook payload (text and quick-reply buttons).
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
          /** Template quick-reply (007). */
          button?: { text?: string; payload?: string };
          /** Interactive message reply (007). */
          interactive?: { type?: string; button_reply?: { id?: string; title?: string } };
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
        // Text, or a button the patient tapped (read as the button's text — 007 FR-707).
        const text =
          m.type === "text"
            ? m.text?.body
            : m.type === "button"
              ? m.button?.text
              : m.type === "interactive"
                ? m.interactive?.button_reply?.title
                : undefined;
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
