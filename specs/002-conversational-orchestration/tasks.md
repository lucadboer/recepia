# Tasks: Conversational Orchestration

**Tests**: REQUIRED (constitution Test-First). Behavioral tests assert tool/DB/fake side-effects, never LLM text. RED→GREEN per task. Conventional commit per phase; suite always green.

## Phase 0 — Spec (SDD gate)
- [x] T200 Author `specs/002-*` artifacts + update CLAUDE.md SPECKIT block (decisions deferred)

## Phase 1 — LLMPort + FakeLLM + conversation state
- [x] T201 [P] `src/ports/llm-port.ts`, `src/ports/conversation-store-port.ts`, `src/agent/types.ts`
- [x] T202 [P] `src/agent/conversation.ts` (pure reducers) + `tests/unit/conversation.test.ts` (RED first)
- [x] T203 [P] `src/adapters/fakes/{fake-llm,fake-conversation-store}.ts` + `tests/unit/fake-llm.test.ts`

## Phase 2 — Deterministic triage + intent (escalate-on-doubt backstop)
- [x] T204 `src/agent/triage.ts` + `tests/unit/triage.test.ts` (one case per trigger + negatives)
- [x] T205 `src/agent/intent.ts` + `tests/unit/intent.test.ts`

## Phase 3 — Tool registry + schemas + structural guardrails
- [x] T206 `src/agent/tool-schemas.ts`, `src/agent/reply.ts` + `tests/unit/reply.test.ts`
- [x] T207 `src/agent/tool-registry.ts` + `tests/integration/tool-registry.test.ts` (non-offered slot / foreign holdId / unknown tool rejected)

## Phase 4 — Consent
- [x] T208 `src/db/migrations/005_patient_consent.sql`, `src/db/repositories/consent-repo.ts`, `src/agent/consent.ts`; extend `AuditAction`; extend `resetDb`
- [x] T209 `tests/integration/consent.test.ts`

## Phase 5 — Orchestrator (keystone)
- [x] T210 `src/agent/orchestrator.ts`, `src/agent/system-prompt.ts`, `AgentDeps`, errors
- [x] T211 behavioral tests: book-happy, no-write-guardrail, confirm-requires-hold, slot-must-come-from-availability, triage-escalation (LLM not called), consent-gate, max-iterations, tool-error-recovery, idempotent-inbound

## Phase 6 — Inbound parsers
- [x] T212 `src/adapters/messaging/inbound/{evolution,cloud-api}-parser.ts` + fixtures + tests

## Phase 7 — Adapter scaffolds (needs-creds)
- [x] T213 `src/adapters/{llm/anthropic-llm,messaging/evolution-messaging,messaging/cloud-api-messaging,calendar/google-calendar}.ts` + `NotConfigured` + `tests/integration/adapter-scaffolds-notconfigured.test.ts`

## Phase 8 — Conversation DB scaffold
- [x] T214 `src/db/migrations/006_conversation_state.sql`, `src/db/repositories/conversation-repo.ts`, extend `resetDb`, finalize `quickstart.md` + `tests/integration/conversation-repo.test.ts`

## NEEDS-USER (do not decide)
Anthropic key+model (see `claude-api` skill), Google Calendar creds, WhatsApp Evolution+Cloud creds, live integration tests, patient/opt-in copy, LGPD retention, escalation routing, webhook hosting, final MAX_ITERATIONS.

## Phase 9 — Convergence (reconciled with real code, 2026-06-19)

> `/speckit-converge`: Phases 1–8 (T201–T214) are implemented and green (107 tests), so their checkboxes above were reconciled to `[x]` at the user's explicit request (a deliberate deviation from converge's append-only default). Below: list-B work already completed beyond the original scope (recorded as done), then the genuinely-remaining work as new traceable tasks for `/speckit-implement`. FR-201…FR-209 are fully satisfied by the implemented code (no findings); the items below are FR-210's remaining real adapters plus the spec's `[DEFERRED — NEEDS-USER]` set, now formalized.

### Completed beyond original scope (list B — done, validated live)
- [x] T215 Real `AnthropicLLM` adapter (Messages API tool-use, model `claude-sonnet-4-6`, thinking off) + `LIVE_LLM` smoke test, replacing the needs-creds scaffold, per FR-210 / plan: LLMPort real adapter (was scaffold). Validated live (commit 2809a0f).
- [x] T216 Real `GoogleCalendar` adapter (API v3, service-account key, least-privilege `calendar.events` scope, deterministic idempotent event id, 404/410-safe delete) + `LIVE_CALENDAR` smoke test, replacing the needs-creds scaffold, per FR-210 / plan: CalendarPort real adapter (was scaffold). Validated live (commit ad9f7ca).

### Open — remaining work
- [x] T217 Implement the real `EvolutionMessaging` outbound adapter (dev WhatsApp) replacing the `NotConfigured` scaffold; add a live test behind a `LIVE_*` flag, out of the default `pnpm test`, per FR-210 / plan: MessagingPort (Evolution) (partial)
- [x] T218 Implement the real `CloudApiMessaging` outbound adapter (prod WhatsApp Cloud API — not open-wa) replacing the `NotConfigured` scaffold; add a live test behind a `LIVE_*` flag, per FR-210 / plan: MessagingPort (Cloud API) (partial)
- [x] T219 Add a composition root that builds `AgentDeps` from real adapters (`AnthropicLLM`, `GoogleCalendar`, real messaging, `DbConversationStore`, `pg` pool) and wires `handleInbound`; add a live end-to-end conversation test (availability → hold → confirm) behind a `LIVE_*` flag — no production wiring exists today (adapters are only built in tests), per US1 (live) / plan: orchestrator wiring (missing)
- [x] T220 **[DECIDED 2026-10-06 — owner accepted the current wording as the pilot copy; `[draft]`/`TODO(product)` markers removed. Tone/clarity will be measured by the eval judge in feature 004.]** Finalize the patient-facing pt-BR copy (greeting, slot offer, confirmation request, recovery) in `reply.ts`/`system-prompt.ts`, per FR-208
- [x] T221 **[DECIDED 2026-10-06 — owner accepted the current opt-in/opt-out wording; counsel review is still recommended before a real pilot (noted in reply.ts).]** Finalize the LGPD legal opt-in/opt-out wording in the consent flow (`consent.ts`/`reply.ts`), per FR-205, Constitution V
- [ ] T222 **[POLICY DECIDED 2026-10-06 — `conversation_state` and `outbox_message` rows are purged after 90 days without activity; `patient_consent` is kept as proof of consent; `audit_log` is append-only and kept. The scheduled purge job lands with feature 005 (observability & cost).]** Implement the LGPD retention purge job, per Constitution V
- [x] T223 **[DECIDED 2026-10-06 — a single reception number (`RECEPTION_PHONE`) notified at any hour; hand-off tone = `reply.escalatedToReception()` / `reply.handedOff()`; release via `pnpm conversation:release`. Queues, business-hours routing and a WhatsApp release command move to feature 003 (multi-tenant).]** Define the escalation routing policy, per FR-204
- [x] T224 Webhook hosting: an HTTP entrypoint that verifies the provider signature, edge-dedupes, and calls `handleInbound` (deploy target), per FR-207, US1 / spec [DEFERRED] hosting (missing)
- [x] T225 **[DECIDED 2026-10-06 — `AGENT_MAX_ITERATIONS = 8` is final (one booking needs 3 tool calls; 8 leaves room for one alternative + recovery). A per-conversation cost budget comes with feature 005.]** Set the final `AGENT_MAX_ITERATIONS`, per FR-206, SC-204

## Phase 10 — Audit findings (NEEDS-USER decision; from the 2026-06-19 hardening/Codex pass)

> Read-only audit (me + 3 Explore agents + Codex CLI gpt-5.5 xhigh). Safe coverage gaps were already closed with TDD (commits `93df4d3`,`b08a4bc`,`aaeb409`,`1c1a922`,`935d7c2`; suite 121→188). The items below CHANGE core behavior / touch a non-negotiable / are product/policy, so they are recorded — NOT implemented — pending your decision. `[~]` = open decision.

### Core / non-negotiable (Codex-found, confirmed in code)
- [x] T226 [P0, core] **[RESOLVED by an honest reframe — claim corrected in hold-slot.ts + 004_seat_model.sql; a characterization test pins the limitation; a real structural guarantee (seat<capacity) deferred to 003/resource-based.]** **Anti-overbooking is not fully structural.** `004_seat_model.sql` only guarantees `seat>=0` + `unique(start_ts,seat)`; `seat < capacity` is missing. The real path (holdSlot picks a seat in [0,capacity) under an advisory lock; test 16×cap2) is safe, but a direct writer with `seat>=capacity` would get through — the "STRUCTURAL backstop" claim exceeds what the DB guarantees. DECISION: a real structural cap (hard because of per-slot capacity overrides — e.g. an exclusion constraint / capacity materialized per slot) OR adjust the claim/scope. Deciding test: inserting `seat=2` at cap 2 must fail (it passes today). per Constitution I (no-overbooking).
- [x] T227 [P0, product = #6] **[RESOLVED 7a10ac9 — the deterministic confirmation owns the message; the orchestrator suppresses its final send only when the confirm succeeds.]** **Double message to the patient on confirm.** `confirmBooking` (confirm-booking.ts:113) sends the deterministic confirmation AND the orchestrator (orchestrator.ts:138-140) sends the LLM's final text → 2 messages on the happy path. DECISION: which layer owns the closing message. per orchestration.md "one message".
- [x] T228 [P0, non-negotiable V] **[RESOLVED b370f53 — reclaimExpiredHoldsForSlot returns the ids; holdSlot audits hold_expired in the same transaction.]** **Lazy reclaim without audit.** `reclaimExpiredHoldsForSlot` (booking-repo.ts:43-53) moves held→expired WITHOUT an `audit_log` row; the sweep (`expireHolds`) audits `hold_expired`. It breaks "every write is recorded in audit_log". DECISION: audit the reclaim inside holdSlot's transaction. per Constitution V.

### Robustness / policy (Codex-found)
- [x] T229 [P1] **[RESOLVED — T246: routing by exact `pathname`; `/webhook/evolutionary/...` and `/webhook/cloud-x` → 404.]** **Prefix collision in the webhook path:** `startsWith(basePath)` (server.ts:30) sends `/webhook/evolutionary/...` to auth (401) instead of 404. Suggested fix: require a separator after the basePath (low risk; becomes a safe fix if approved).
- [x] T230 [P1] **[RESOLVED — T246: explicit at-least-once semantics; the id only enters `RecentIds` after `onInbound` resolves; durable idempotency remains `processedInboundIds`.]** **Edge dedupe × redelivery after a failure:** the id is recorded in `RecentIds` before `onInbound` succeeds (dispatch.ts:87/server.ts:49); the orchestrator also marks it processed at the start. DECISION: at-least-once × at-most-once semantics.
- [x] T231 [P1] **[RESOLVED — T242: the confirmation is enqueued in `outbox_message` in the same transaction as the commit; `dispatchOutbox` redelivers with backoff and dead-letter + a reception notice (FR-214).]** **Post-commit messaging failure with no recovery:** if the send to the patient fails after the commit, the booking stays confirmed with no notification; a retry returns idempotently without resending. DECISION: recovery contract (resend/escalate).
- [x] T232 [P2, latent] **[RESOLVED — T242: `confirmed` is only assigned after the COMMIT resolves; the test "COMMIT fails after the UPDATE" pins the behaviour.]** **`confirmed` assigned before the COMMIT** (confirm-booking.ts): if the COMMIT throws after `confirmHeld`, the code still sends a confirmation and returns `confirmed` despite the rollback. Rare edge; consider a guard.
- [x] T234 [P2, post-pilot — TECHNICAL DEBT] **[RESOLVED — T245: the sweep audits the ids from the `UPDATE … RETURNING`; a race test with an interceptor pins "1 hold_expired per id".]** **Duplicate (not missing) audit in a sweep × lazy-reclaim race.** The sweep (`jobs/expire-holds.ts:11-24`) audits the ids from the `SELECT`, not those from the UPDATE's `RETURNING`; if `holdSlot`'s lazy reclaim (T228) expires+audits a hold between the sweep's `SELECT` and `UPDATE`, the sweep still writes a stale `hold_expired` → 2 audit rows for the same expiry. It is **over-audit** and does NOT break non-negotiable V (nothing goes unrecorded). Finding #4 of the Codex review of the T226/T227/T228 fixes (triaged as low risk). Suggested fix: the sweep audits by the ids from the UPDATE's `RETURNING` (or takes the slot's advisory lock). Left for after the pilot.
- [x] T235 [P3, technical note — post-pilot] **[RESOLVED — T244: `ToolDispatchResult.patientNotified` (a role-based flag coming from the confirm) replaces the per-phone counter; the test "RECEPTION_PHONE == patient" pins the behaviour.]** **The "confirmation delivered" counter identifies the patient by number, not by role.** The per-turn messaging wrapper (`orchestrator.ts:93-98`, the T227 fix) increments when `to === msg.phone`. Correct in production, where reception ≠ patient. But if `RECEPTION_PHONE` == the patient's number (an artifact of a solo demo config), an escalation would match `to === msg.phone` and count as a confirmation, suppressing the LLM's final text — it does **not** cause silence (the number receives the escalation = 1 msg), it only swaps the closing message. It does NOT touch the critical path. If robustness requires it, count by a sentinel/role (e.g. mark the sends made by `confirm_booking`) instead of the number. Low priority. Operational mitigation: in live demos, use DIFFERENT numbers for reception and patient.

### Mine
- [ ] T233 [recommended NOT to do] A direct fail-fast test of the `buildAgentDeps` composition root: effective coverage already exists through the individual adapters (adapter-scaffolds-notconfigured.test.ts); a direct test is brittle (coupled to `loadEnv()/.env`). Recommend closing with no action.

## Phase 11 — Hardening (correctness fixes before pilot; from the 2026-10-05 review)

> Scope: close the open P1/P2 findings of Phase 10 and the correctness gaps found in the 2026-10-05 code review (escalations without the patient's phone, no handed-off state, undated prompt with a fixed UTC offset, unbounded state, lost updates on concurrent messages, post-commit messaging failures, webhook hardening). Product decisions → [spec.md](spec.md) (FR-204 amended, FR-211–FR-214, SC-206). Technical decisions → [plan.md](plan.md) "Hardening addendum". TDD per task (RED → GREEN → refactor); one conventional commit per task.

- [x] T236 Escalations carry the patient phone + a deterministic last-N conversation summary (triage path, max_iterations path, `escalate_to_human` tool, `confirm_booking` failure paths), per FR-204 (amended)
- [x] T237 Handed-off state: `status = escalated` short-circuits the loop (no LLM call, no second reception notification); one pt-BR notice per `HANDOFF_NOTICE_INTERVAL_MS`; opt-out still honoured; `completed` conversations reset on the next inbound keeping dedupe ids; `pnpm conversation:release <phone>` CLI + optional `HANDOFF_AUTO_RELEASE_HOURS`, per FR-211, FR-212
- [x] T238 IANA timezone via `Intl` in `domain/time.ts` + `messages.ts` (drop `CLINIC_UTC_OFFSET_MINUTES`); dated `buildSystemPrompt({ now, timezone })` so the model can build correct ISO ranges, per FR-213
- [x] T239 Bound `ConversationState`: history trimmed at user-turn boundaries (tool_use/tool_result pairs never split), past offered slots pruned, caps on offered slots / active holds / processed ids, per plan "state bounds"
- [x] T240 Optimistic concurrency: `conversation_state.version` (migration 007) + `ConversationConflictError` on stale save; per-phone in-process serialization in the webhook, per plan "concurrency"
- [x] T241 Transactional outbox: `outbox_message` table (migration 008) + repo + `dispatchOutbox` job (`FOR UPDATE SKIP LOCKED`, backoff, dead-letter audit + escalation), per FR-214
- [x] T242 `confirm_booking` enqueues the patient confirmation inside the commit transaction; `confirmed` is assigned only after COMMIT resolves — closes T231, T232
- [x] T243 `escalate_to_human` writes the `escalated` audit row and the reception outbox row in one transaction — closes the send-before-audit ordering
- [x] T244 `ToolDispatchResult.patientNotified` replaces the phone-based send counter (closes T235); an `escalated` tool result stops the loop deterministically
- [x] T245 `server.ts` schedules `dispatchOutbox` + `expireHolds`; the sweep audits the ids from `UPDATE … RETURNING` — closes T234
- [x] T247 **[DECIDED 2026-10-06 — keep answering: opt-out blocks proactive messages (queued notifications cancelled) and `confirm_booking` (consent gate); the agent still replies when the patient writes. This is the current behaviour, pinned by `orchestrator-optout.test.ts`.]** After an opt-out the agent still answers later messages, per FR-205 / LGPD "easy opt-out". Found in the Codex review of Phase 11.
- [x] T248 FR-213 amendment (2026-10-07, found by the 004 live baseline): `get_availability` / `hold_slot` / `confirm_booking` results carry clinic-local ISO times (`toLocalIso`) and a pt-BR label (`slotLabelPt`); the gate keeps comparing normalized instants, so a slot quoted back in either spelling is the same offered slot (`src/agent/tool-registry.ts`, `src/domain/time.ts`, tests in `tests/integration/tool-registry.test.ts`, `tests/unit/time.test.ts`)
- [x] T246 Webhook: exact pathname routing (closes T229), 256 KiB body limit → 413, request/headers timeouts, graceful shutdown (SIGTERM/SIGINT drain), edge dedupe recorded only after `onInbound` succeeds (closes T230, at-least-once)
