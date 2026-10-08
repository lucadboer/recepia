# Data Model: Reschedule and Cancel over WhatsApp

## booking (changed — migration 011)
| Column | Type | Rule |
|---|---|---|
| `cancelled_at` | `timestamptz NULL` | `CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))` |
| `rescheduled_from` | `uuid NULL REFERENCES booking(id)` | `UNIQUE (rescheduled_from) WHERE rescheduled_from IS NOT NULL` — at most one successful reschedule per booking |

New index: `(patient_phone, start_ts) WHERE status IN ('confirmed','patient_confirmed')` (upcoming lookup).

Lifecycle (statuses unchanged, new transitions in bold):
```
held ──confirm──▶ confirmed ──(007)──▶ patient_confirmed
  │                  │  ▲                    │
  │ expire/release   │  └── reschedule: a NEW row (held → confirmed, rescheduled_from = old)
  ▼                  ▼                       ▼
expired       **cancelled** ◀── cancel / replaced by reschedule ──┘
```
A cancelled row keeps its seat number but no longer occupies it (`booking_slot_seat_uq` excludes `cancelled`, `countActiveInRange` counts only active statuses).

## outbox_message (changed — migration 011)
`kind` CHECK: `booking_confirmation | escalation | booking_cancellation | reception_notice`.
Dedupe keys: `booking_cancellation:<bookingId>`, `booking_confirmation:<newBookingId>` (reschedule), `late_change:<oldBookingId>`, `calendar_cleanup:<bookingId>`.

## audit_log (new actions)
| Action | Entity / id | Payload |
|---|---|---|
| `booking_cancelled` | booking / cancelled id | `{ reason: "patient" \| "rescheduled", start, late, outboxId?, promptVersion? }` |
| `booking_rescheduled` | booking / new id | `{ from, fromStart, start, eventId, late, outboxId, promptVersion? }` |
| `calendar_delete_failed` | booking / id | `{ eventId, reason }` |

## conversation_state.state (JSON, changed)
| Field | Type | Rule |
|---|---|---|
| `turnSeq` | `number` | +1 per accepted inbound message; default 0 for legacy rows |
| `surfacedBookings` | `{ bookingId: string; turn: number }[]` | written by `find_my_booking`; capped at 5; cleared by `resetConversation` |
| `holdSeqs` | `{ holdId: string; turn: number }[]` | written by `hold_slot`; capped like `activeHoldIds`; cleared by `resetConversation` |
