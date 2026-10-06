# Data Model: Conversational Orchestration

## New tables

### `patient_consent` — opt-in/opt-out ledger (migration 005)
| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `phone` | text NOT NULL | patient WhatsApp number |
| `state` | text NOT NULL | `opted_in` \| `opted_out` |
| `source` | text | e.g. `whatsapp_optin`, `reception` |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |

Index `(phone, created_at DESC)`. **Latest row wins** → `hasConsent(phone)` = latest row is `opted_in`. Append-style (auditable, reversible). Each change also appends an `audit_log` row (`consent_recorded` / `consent_revoked`).

### `conversation_state` — per-phone orchestration state (migration 006)
| Field | Type | Notes |
|---|---|---|
| `phone` | text PK | one live conversation per patient |
| `state` | jsonb NOT NULL | serialized `ConversationState` (below) |
| `version` | integer NOT NULL DEFAULT 0 | optimistic concurrency (migration 007); `save` is a compare-and-swap on this column |
| `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Retention/purge `[DEFERRED — NEEDS-USER]` (LGPD finalidade/retention).

### `outbox_message` — transactional outbox for patient/reception messages (migration 008)
| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `kind` | text NOT NULL | `booking_confirmation` \| `escalation` |
| `to_phone` | text NOT NULL | recipient |
| `body` | text NOT NULL | pt-BR message, rendered at enqueue time |
| `dedupe_key` | text UNIQUE NULL | e.g. `booking_confirmation:<bookingId>`; dedupes enqueue, not delivery |
| `status` | text NOT NULL | `pending` \| `sent` \| `failed` |
| `attempts` | integer NOT NULL DEFAULT 0 | |
| `next_attempt_at` | timestamptz NOT NULL | backoff schedule |
| `last_error` | text | |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |
| `sent_at` | timestamptz | CHECK `(status = 'sent') = (sent_at IS NOT NULL)` |

Partial index on `next_attempt_at WHERE status = 'pending'`. Rows are written in the same transaction as the domain write they announce (`booking_confirmed`, `escalated`), whose audit payload carries the `outboxId`. Claimed one per transaction with `FOR UPDATE SKIP LOCKED`. Dead-letter after 6 attempts → `outbox_dead_letter` audit row + escalation row for reception.

## Derived types (not all persisted as columns)

```ts
interface ConversationState {
  phone: string;
  status: "active" | "escalated" | "completed";
  history: LlmMessage[];          // running tool-use transcript — bounded (HISTORY_MAX_MESSAGES, trimmed at user-turn boundaries)
  offeredSlots: string[];         // ISO starts returned by get_availability (guardrail 2) — past slots pruned, capped
  activeHoldIds: string[];        // hold ids created this conversation (guardrail 3) — capped
  lastConfirmedBookingId: string | null;
  processedInboundIds: string[];  // idempotency (FR-207) — capped (most recent kept)
  patientName: string | null;
  awaitingConsent: boolean;       // set when confirm was blocked pending opt-in
  escalatedAt: string | null;     // ISO; set by markEscalated (FR-211)
  handoffNoticeAt: string | null; // ISO; last "a recepção vai continuar" notice (FR-211)
  version: number;                // optimistic concurrency; 0 = never persisted
  updatedAt: Date;
}

interface InboundMessage { phone: string; text: string; providerMessageId: string; receivedAt?: Date; }
```

## LLMPort content shape (mirrors Anthropic tool use)
```ts
type LlmContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean };
interface LlmMessage { role: "user" | "assistant"; content: LlmContent[]; }
interface LlmTurnResult { stopReason: "tool_use" | "end_turn" | "max_tokens"; content: LlmContent[]; }
```

## Escalation triggers (FR-204) — full list (deterministic triage, diacritic-insensitive)
1. urgency / pain — `dor`, `urgente`, `urgência`, `emergência`, `sangrando`
2. specialized procedure — `invisalign`, `ortodontia`, `aparelho`, `implante`, `cirurgia`, `canal`, `clareamento`(?)→ keep conservative: invisalign/ortho/implant/surgery/canal
3. ongoing treatment — `tratamento em andamento`, `continuação`, `retorno do canal`
4. specific professional — `dr.`, `dra.`, `doutor`, `doutora`, `dentista X`
5. complaint — `reclamação`, `reclamar`, `processar`, `insatisfeito`
6. financial — `preço`, `valor`, `quanto custa`, `convênio`, `plano`, `parcelar`
7. non-routine appointment type — anything not in `ROUTINE_TYPES`
8. ambiguity marker / explicit human request — `falar com atendente`, `humano`, `recepção`
9. empty horizon — no free slot within 30 days (already handled by `offerAlternativesOrEscalate`)

Exact keyword set is tuned in `triage.ts` with a unit test per category; final wording/coverage is refinable but the categories are fixed by the constitution.

## Invariants (test targets)
1. No write path bypasses the deterministic tools (closed allowlist) — hostile-FakeLLM test.
2. `offeredSlots`/`activeHoldIds` gate holds/confirms — guardrail tests.
3. `hasConsent(phone)` false ⇒ no `confirm_booking` dispatch.
4. Triage match ⇒ `escalateToHuman` + no LLM call + no booking.
5. Loop iterations ≤ `MAX_ITERATIONS`.
6. Duplicate `providerMessageId` ⇒ no second side-effect.
7. `status = escalated` ⇒ no LLM call, no second reception notification until release (FR-211).
8. Stale `version` on save ⇒ `ConversationConflictError`, no overwrite (lost-update proof).
9. `booking_confirmed` / `escalated` committed ⇒ a matching `outbox_message` row exists in the same transaction (FR-214).
10. History trimming never splits a `tool_use` from its `tool_result`; the trimmed history always starts with a user text message.

## Audit actions (extended)
`hold_created`, `hold_expired`, `hold_released`, `booking_confirmed`, `calendar_orphan_compensated`, `escalated`, `consent_recorded`, `consent_revoked`, **`outbox_dead_letter`** (actor `system`), **`conversation_released`** (actor `human`).
