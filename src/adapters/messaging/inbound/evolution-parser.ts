import type { InboundMessage } from "../../../agent/types";

// Minimal shape of an Evolution API `messages.upsert` webhook payload (text only).
interface EvolutionPayload {
  event?: string;
  data?: {
    key?: { remoteJid?: string; fromMe?: boolean; id?: string };
    message?: { conversation?: string; extendedTextMessage?: { text?: string } };
    pushName?: string;
  };
}

/** Parse an Evolution inbound webhook into a normalized InboundMessage, or null to ignore. */
export function parseEvolutionInbound(payload: unknown): InboundMessage | null {
  const p = payload as EvolutionPayload;
  if (p?.event !== "messages.upsert") return null;

  const key = p.data?.key;
  if (!key || key.fromMe) return null; // ignore our own outbound echoes

  const jid = key.remoteJid ?? "";
  if (!jid || jid.endsWith("@g.us")) return null; // ignore non-jid and group chats

  const text = p.data?.message?.conversation ?? p.data?.message?.extendedTextMessage?.text;
  if (typeof text !== "string" || text.length === 0) return null; // ignore non-text/empty

  const phone = jid.split("@")[0];
  if (!phone || !key.id) return null;

  return { phone: `+${phone}`, text, providerMessageId: key.id };
}
