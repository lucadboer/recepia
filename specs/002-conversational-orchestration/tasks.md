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
- [x] T226 [P0, núcleo] **[RESOLVIDO via reframe honesto — alegação corrigida em hold-slot.ts + 004_seat_model.sql; teste de caracterização fixa a limitação; garantia estrutural real (seat<capacity) deferida à 003/resource-based.]** **Anti-overbooking não é totalmente estrutural.** `004_seat_model.sql` garante só `seat>=0` + `unique(start_ts,seat)`; falta `seat < capacity`. O caminho real (holdSlot escolhe assento em [0,capacity) sob advisory lock; teste 16×cap2) é seguro, mas um writer direto com `seat>=capacity` furaria — a alegação "STRUCTURAL backstop" excede o que o DB garante. DECISÃO: cap estrutural real (difícil por overrides de capacidade por slot — ex.: exclusion constraint / capacidade materializada por slot) OU ajustar a alegação/escopo. Teste decisório: inserir `seat=2` em cap 2 deve falhar (hoje passa). per Constitution I (no-overbooking).
- [x] T227 [P0, produto = #6] **[RESOLVIDO 7a10ac9 — confirmação determinística é dona da mensagem; orquestrador suprime o envio final só quando o confirm tem sucesso.]** **Dupla mensagem ao paciente no confirm.** `confirmBooking` (confirm-booking.ts:113) envia a confirmação determinística E o orquestrador (orchestrator.ts:138-140) envia o texto final da LLM → 2 mensagens no caminho feliz. DECISÃO: qual camada é dona da mensagem de fechamento. per orchestration.md "one message".
- [x] T228 [P0, não-negociável V] **[RESOLVIDO b370f53 — reclaimExpiredHoldsForSlot retorna os ids; holdSlot audita hold_expired na mesma transação.]** **Lazy reclaim sem audit.** `reclaimExpiredHoldsForSlot` (booking-repo.ts:43-53) faz held→expired SEM linha de `audit_log`; o sweep (`expireHolds`) audita `hold_expired`. Fere "toda escrita registra em audit_log". DECISÃO: auditar o reclaim dentro da transação do holdSlot. per Constitution V.

### Robustez / política (Codex-found)
- [x] T229 [P1] **[RESOLVIDO — T246: roteamento por `pathname` exato; `/webhook/evolutionary/...` e `/webhook/cloud-x` → 404.]** **Colisão de prefixo no path do webhook:** `startsWith(basePath)` (server.ts:30) faz `/webhook/evolutionary/...` cair em auth (401) em vez de 404. Fix sugerido: exigir separador após o basePath (baixo risco; vira safe-fix se aprovado).
- [x] T230 [P1] **[RESOLVIDO — T246: semântica at-least-once explícita; o id só entra no `RecentIds` após `onInbound` resolver; a idempotência durável continua sendo `processedInboundIds`.]** **Dedupe de borda × reentrega após falha:** o id é gravado em `RecentIds` antes de `onInbound` ter sucesso (dispatch.ts:87/server.ts:49); o orquestrador também marca processed no início. DECISÃO: semântica at-least-once × at-most-once.
- [x] T231 [P1] **[RESOLVIDO — T242: a confirmação é enfileirada em `outbox_message` na mesma transação do commit; `dispatchOutbox` reentrega com backoff e dead-letter + aviso à recepção (FR-214).]** **Falha de mensageria pós-commit sem recuperação:** se o envio ao paciente falhar após o commit, o booking fica confirmado sem notificação; retry retorna idempotente sem reenviar. DECISÃO: contrato de recuperação (reenvio/escala).
- [x] T232 [P2, latente] **[RESOLVIDO — T242: `confirmed` só é atribuído após o COMMIT resolver; teste "COMMIT falha após o UPDATE" fixa o comportamento.]** **`confirmed` atribuído antes do COMMIT** (confirm-booking.ts): se o COMMIT lançar após `confirmHeld`, o código ainda envia confirmação e retorna `confirmed` apesar do rollback. Edge raro; avaliar guarda.
- [x] T234 [P2, pós-piloto — DÍVIDA TÉCNICA] **[RESOLVIDO — T245: o sweep audita os ids do `UPDATE … RETURNING`; teste de corrida com interceptor fixa "1 hold_expired por id".]** **Audit duplicado (não faltante) em corrida sweep × lazy-reclaim.** O sweep (`jobs/expire-holds.ts:11-24`) audita os ids do `SELECT`, não os do `RETURNING` do UPDATE; se o lazy reclaim do `holdSlot` (T228) expira+audita um hold entre o `SELECT` e o `UPDATE` do sweep, o sweep ainda grava um `hold_expired` obsoleto → 2 linhas de audit pro mesmo expiry. É **over-audit**, NÃO fere a não-negociável V (nada fica sem registro). Achado #4 da revisão Codex dos fixes T226/T227/T228 (triado como baixo risco). Fix sugerido: o sweep auditar pelos ids do `RETURNING` do UPDATE (ou pegar o advisory lock do slot). Deixado pro pós-piloto.
- [x] T235 [P3, nota técnica — pós-piloto] **[RESOLVIDO — T244: `ToolDispatchResult.patientNotified` (flag por papel, vindo do confirm) substitui o contador por telefone; teste "RECEPTION_PHONE == paciente" fixa o comportamento.]** **O contador de "confirmação entregue" identifica o paciente por número, não por papel.** O wrapper de messaging por turno (`orchestrator.ts:93-98`, fix do T227) incrementa quando `to === msg.phone`. Correto em produção, onde recepção ≠ paciente. Porém, se `RECEPTION_PHONE` == número do paciente (artefato da config de demo solo), uma escalação cairia em `to === msg.phone` e contaria como confirmação, suprimindo o texto final da LLM — **não** gera silêncio (o número recebe a escalação = 1 msg), só troca a mensagem de fechamento. NÃO toca o caminho crítico. Se a robustez exigir, contar por um sentinela/papel (ex.: marcar os envios feitos pelo `confirm_booking`) em vez do número. Baixa prioridade. Mitigação operacional: em demos ao vivo, usar números DIFERENTES para recepção e paciente.

### Mine
- [ ] T233 [recomendado NÃO fazer] Teste direto de fail-fast do composition root `buildAgentDeps`: cobertura efetiva já existe via adapters individuais (adapter-scaffolds-notconfigured.test.ts); teste direto é frágil (acoplado a `loadEnv()/.env`). Recomendo encerrar sem ação.

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
- [x] T247 **[DECIDED 2026-10-06 — keep answering: opt-out blocks proactive messages (queued notifications cancelled) and `confirm_booking` (consent gate); the agent still replies when the patient writes. This is the current behaviour, pinned by `orchestrator-optout.test.ts`.]** After an opt-out the agent still answers later messages, per FR-205 / LGPD "opt-out fácil". Found in the Codex review of Phase 11.
- [x] T246 Webhook: exact pathname routing (closes T229), 256 KiB body limit → 413, request/headers timeouts, graceful shutdown (SIGTERM/SIGINT drain), edge dedupe recorded only after `onInbound` succeeds (closes T230, at-least-once)
