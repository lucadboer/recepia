# Contract: Integration Ports

No direct Google Calendar or WhatsApp call is allowed without one of these testable ports (constitution: Domain Restrictions). This slice ships **interfaces + in-memory fakes**; real adapters are deferred. Format: **API + Guarantees + Required Tests** (the tests target the fakes and the port consumers).

```ts
// src/ports/calendar-port.ts
interface CalendarPort {
  // idempotencyKey = booking id → same key returns the same eventId, never a duplicate
  createEvent(input: {
    idempotencyKey: string;
    start: Date; end: Date;
    title: string; patientName: string; patientPhone: string;
  }): Promise<{ eventId: string }>;
}

// src/ports/messaging-port.ts
interface MessagingPort {
  sendMessage(to: string, body: string): Promise<void>;   // body is pt-BR
}

// src/ports/clock.ts
interface Clock {
  now(): Date;
}
```

> `MessagingPort.onMessage` (inbound) and Calendar read/sync (watch API, sync tokens, manual-booking ingestion) belong to later slices and are intentionally **out** of this contract.

---

## `CalendarPort`

**Guarantees**
- `createEvent` is **idempotent** on `idempotencyKey`: the same key returns the same `eventId` and creates no duplicate event.
- Returns the `eventId` to be stored as `booking.google_event_id`.
- May throw a transient error; `confirm_booking` owns the retry/escalation policy (the port does not retry).

**Required Tests** (against `FakeCalendar`)
- Two `createEvent` calls with the same `idempotencyKey` create one event and return the same `eventId`.
- A `FakeCalendar` configured to fail surfaces the error to `confirm_booking` (drives the retry → escalate path).

## `MessagingPort`

**Guarantees**
- `sendMessage` delivers to the given recipient; body is a pt-BR string (FR-019).
- Two real consumers later: Evolution API (dev/demo) and Cloud API (pilot) — the interface is built once.

**Required Tests** (against `FakeMessaging`)
- `confirm_booking` sends exactly one confirmation message to the patient on success.
- `escalate_to_human` sends exactly one message to reception with context.
- No patient confirmation is sent when the calendar event was not written.

## `Clock`

**Guarantees**
- `now()` is the single time source for TTL, horizon, expiry, and the sweep job.

**Required Tests** (against `FakeClock`)
- Advancing the fake clock past `expires_at` makes a held slot expire (lazy read + sweep).
- Horizon bounds (`now+2h`, `now+30d`) move with the fake clock.
