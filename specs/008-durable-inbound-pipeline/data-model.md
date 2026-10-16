# Data Model: Durable Inbound Message Pipeline

## inbound_message (migration 013)
| Column | Type | Rule |
|---|---|---|
| `id` | `bigserial` PK | arrival order |
| `provider` | `text` | `evolution` \| `cloud` |
| `provider_message_id` | `text` | `UNIQUE (provider, provider_message_id)` |
| `phone` | `text` | patient phone (E.164) |
| `body` | `text NULL` | cleared when done |
| `received_at` | `timestamptz` | provider timestamp or insert time |
| `status` | `text` | `pending` \| `processing` \| `done` \| `dead` \| `dropped` |
| `attempts` | `int` | incremented on claim |
| `next_attempt_at` | `timestamptz` | due time for pending rows |
| `locked_by` / `locked_until` | `text` / `timestamptz` | lease of a processing row: the current claim's token (`<worker>/<uuid>`, new per claim) and its expiry |
| `last_error` | `text NULL` | error type only (no content) |
| `trace_context` | `text NULL` | W3C traceparent of the webhook span |
| `processed_at` | `timestamptz NULL` | when done/dead |

Indexes: `(phone, id) WHERE status IN ('pending','processing')`, `(next_attempt_at) WHERE status = 'pending'`.

## audit_log
- New action `inbound_dead_letter` (`entity: inbound`, payload `{ provider, attempts, lastError }`).

## `booking.event_cleanup_pending` (review addition, migration 013)
`boolean NOT NULL DEFAULT false`, partial index where true. Set when a turn that lost its inbound
message had written a hold's calendar event but could not commit: the hold and the event are left
to the new holder. The hold sweep (`removeAbandonedEvents`) deletes the event of a flagged hold that
ended `expired` (or files a reception cleanup notice) and clears the flag; a confirmed booking keeps
its event.
