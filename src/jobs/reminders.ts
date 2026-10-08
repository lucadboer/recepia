// 007 appointment-reminders (SPEC.md US2): the agent's only proactive messages. Both jobs are
// deterministic writers — claim (SKIP LOCKED) → stamp → outbox → audit in one transaction.

import { appendAudit } from "../db/repositories/audit-repo";
import { enqueueOutbox } from "../db/repositories/outbox-repo";
import {
  claimDueReminders,
  claimUnconfirmed,
  markReminderSent,
  markUnconfirmedNoticed,
} from "../db/repositories/reminder-repo";
import type { Deps } from "../deps";
import { reminderMessagePt, reminderTemplateParams, unconfirmedNoticePt } from "../messages";

export interface ReminderSettings {
  /** How long before the appointment the reminder goes out (owner: 24 h). */
  leadMs: number;
  /** How long before the appointment reception hears about a patient who did not answer (3 h). */
  noticeLeadMs: number;
  /** Approved WhatsApp template for the official channel; null = plain text. */
  template: { name: string; language: string } | null;
  batchSize?: number;
}

const DEFAULT_BATCH = 50;

/** Queue one reminder per qualifying booking (contract reminders.md, FR-701/702). */
export async function enqueueDueReminders(
  deps: Deps,
  settings: ReminderSettings,
): Promise<{ queued: number }> {
  const now = deps.clock.now();
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const due = await claimDueReminders(
      client,
      now,
      settings.leadMs,
      settings.noticeLeadMs,
      settings.batchSize ?? DEFAULT_BATCH,
    );
    for (const b of due) {
      const input = { name: b.patientName, type: b.appointmentType, start: b.start };
      await markReminderSent(client, b.id, now);
      const outboxId = await enqueueOutbox(client, {
        kind: "appointment_reminder",
        toPhone: b.patientPhone,
        conversationPhone: b.patientPhone,
        body: reminderMessagePt(input),
        dedupeKey: `appointment_reminder:${b.id}`,
        template: settings.template
          ? { ...settings.template, params: reminderTemplateParams(input) }
          : null,
        now,
      });
      await appendAudit(client, {
        entity: "booking",
        entityId: b.id,
        action: "reminder_enqueued",
        actor: "system",
        payload: {
          start: b.start.toISOString(),
          outboxId,
          template: settings.template?.name ?? null,
        },
      });
    }
    await client.query("COMMIT");
    return { queued: due.length };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** One reception notice per reminded booking the patient did not answer (FR-705). */
export async function notifyUnconfirmed(
  deps: Deps,
  settings: ReminderSettings,
): Promise<{ notified: number }> {
  const now = deps.clock.now();
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const silent = await claimUnconfirmed(
      client,
      now,
      settings.noticeLeadMs,
      settings.batchSize ?? DEFAULT_BATCH,
    );
    for (const b of silent) {
      await markUnconfirmedNoticed(client, b.id, now);
      const outboxId = await enqueueOutbox(client, {
        kind: "reception_notice",
        toPhone: deps.receptionPhone,
        conversationPhone: b.patientPhone,
        body: unconfirmedNoticePt({
          name: b.patientName,
          phone: b.patientPhone,
          type: b.appointmentType,
          start: b.start,
        }),
        dedupeKey: `unconfirmed:${b.id}`,
        now,
      });
      await appendAudit(client, {
        entity: "booking",
        entityId: b.id,
        action: "unconfirmed_notified",
        actor: "system",
        payload: { start: b.start.toISOString(), outboxId },
      });
    }
    await client.query("COMMIT");
    return { notified: silent.length };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
