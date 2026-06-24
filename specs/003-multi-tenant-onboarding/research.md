# Phase 0 Research (DECIDED): Multi-Tenant Onboarding — `003-multi-tenant-onboarding`

> **Status: discovery, decisions D1–D7 RESOLVED.** Still **not a spec** and **no code** — 003 stays on hold until a real 2nd clinic exists (YAGNI, constitution III). This doc now records the resolved product/policy calls (see §7) and reflects them in the model below. External claims are cited (§9); unverified bits are marked **[a confirmar]**. The constitution is **not** edited here — only a **proposed amendment** is drafted (§8) to apply later via `/speckit.constitution`.
>
> **North star (now aligned with the decided model):** a clinic goes live by connecting **WhatsApp + their calendar** — those two connections are the canonical, and near-only, effort on their side.

## 0. What changes vs today (single-tenant)
Today recepia is single-tenant: one Postgres, one Google Calendar, one WABA, one `receptionPhone`, all from a single `.env`. `buildAgentDeps()` ([src/composition.ts](../../src/composition.ts)) reads one clinic's config; the webhook ([src/webhook/server.ts](../../src/webhook/server.ts)) routes every inbound to one `handleInbound`. Ports (`CalendarPort`, `MessagingPort`, `Clock`) are already injected — the lever that makes multi-tenant an **evolution, not a rewrite** (§6).

---

## 1. Catalog: everything it took to wire ONE clinic (from what we lived)

| # | Item | Per-clinic? | Automatable / eliminable (clinic-side)? | Irreducible minimum |
|---|------|-------------|------------------------------------------|---------------------|
| 1 | Create Meta Developer **App** (`Recepia Bot`) | **Provider, one-time** | Yes — done once by us | none (clinic) |
| 2 | Create + **verify Business Account** (hit lock `131031` → CNPJ) | Per business | Partial — Embedded Signup guides it; each clinic's **own WABA** stays tied to **their** business | Clinic authorizes/owns a WABA (their CNPJ) — §2 |
| 3 | Get `phone_number_id` + token | Per clinic | **Yes** — returned by Embedded Signup code-exchange, stored automatically | none (clinic) |
| 4 | Verify test recipient + open 24h window | Test-mode only | **Eliminated in production** (real number → no allow-list; 24h window is an inherent messaging rule) | none |
| 5 | Token lifecycle (temp 24h → permanent) | Per clinic | **Yes** — Embedded Signup yields a long-lived **Business Integration System User token** [src: Access Tokens] | none (clinic) |
| 6 | Calendar connection (was SA-share + calendar id) | Per clinic | Becomes **1-click Google OAuth**; **necessary** (read+write reconciliation, §3), not cosmetic | ~3 clicks (Google consent) |
| 7 | Populate `.env` | Per clinic | **Yes** — replaced by a `tenant` row created during onboarding | none |
| 8 | Reception number, capacity/hours, appointment types | Per clinic | Partial — smart defaults + quick form | a few fields (defaultable) |

**Reading:** almost everything that hurt is provider-side one-time or automatable. The genuinely clinic-side irreducible bits are **(a)** authorizing their own WhatsApp number (§2), **(b)** connecting their calendar (§3, now required for correctness), and **(c)** their working hours/types (defaultable).

---

## 2. WhatsApp with minimum friction — Tech Provider + Embedded Signup  *(reflects D4)*

**Mechanism (official, decided as the only production channel).** Become a **Tech Provider** and embed **Embedded Signup** — "a scalable authentication and authorization interface launched directly from your website or client portal" ([Embedded Signup overview]). The clinic clicks, logs into Facebook, selects/creates **their** WABA + phone number, and we receive a `code` we **exchange for a Business Integration System User access token** — for "programmatic, automated actions on customer WABAs, without … future re-authentication" ([Access Tokens]). Post-flow we list shared WABAs (`client_whatsapp_business_accounts`) and resolve the WABA id via Debug Token ([Manage accounts]).

**Provider prerequisites (one-time, our side).** App Review + **Advanced Access** for `whatsapp_business_management` + `whatsapp_business_messaging` before onboarding clients ([Become a Tech Provider]).

**Irreducible truth (cravado).** On the **official Cloud API there is no "just give me your number"** — the clinic must own/authorize **their own WABA**, tied to a verified business (**CNPJ**). Embedded Signup is the lowest-friction official path. **CNPJ is not a barrier** — the customer is a clinic, and clinics have a CNPJ (D7).

**Evolution / Baileys — dev only (decided D4).** Keeps the "zero-effort, we scan the QR" property but is **unofficial / against WhatsApp ToS / ban-risk**. Allowed only for **dev/demo** (and an eventual first quick demo) — **never a production default, never on a clinic's main line.** Both adapters already sit behind `MessagingPort` + a `MESSAGING_PROVIDER` switch ([src/composition.ts](../../src/composition.ts)), so this is config.

---

## 3. Calendar — the **reconciliation** model  *(reflects D1 + D2; supersedes the old "optional mirror")*

**Decided operating model: recepia COEXISTS with other booking channels** (phone, walk-in, the dentist's manual blocks). recepia is **not** the exclusive owner of the agenda. Therefore:

- **Postgres is the booking ENGINE and source of truth for recepia's own bookings + holds + the atomic no-overbooking guarantee** (the seat model + `unique(start_ts, seat)` — **kept; it is the jewel, not replaced**). See [src/db/migrations/004_seat_model.sql](../../src/db/migrations/004_seat_model.sql).
- **The clinic's calendar is BIDIRECTIONAL:** a **write sink** (push confirmed bookings) **and** a **read source** (free/busy) to subtract occupations created **outside** recepia.
- **Availability is reconciliation, not a single source:**
  `free(slot) = capacity(slot) − recepiaBookings(slot) [Postgres] − externalBusy(slot) [calendar free/busy]`.
- **Connecting the calendar is NECESSARY, not optional** (this replaces old Design (c)'s cosmetic mirror): any clinic that books outside recepia (≈ all of them) needs the read-back, otherwise recepia offers slots the dentist already filled → **double-booking**. "Skip calendar" is acceptable **only** for a clinic that books 100% through recepia.

**Provider matrix (decided D6: Google only in v1).** Free/busy read support matters now:

| Provider | v1? | OAuth 1-click | Free/busy read | Notes |
|---|---|---|---|---|
| **Google Calendar** | ✅ **v1** | ✅ | ✅ (FreeBusy API) | We already speak this API (002); read+write both supported |
| **Microsoft 365 / Outlook** | ⏳ when a real clinic asks | ✅ (Graph + `offline_access`, `Calendars.ReadWrite`) | ✅ (getSchedule) | Adapter when demanded — **not speculative** (YAGNI) |
| **Apple / iCloud** | ❌ out | ❌ (no public OAuth; CalDAV + app-specific password) | — | High friction; excluded |
| **Calendly** | ❌ out | ⚠️ | — | Competing scheduler / model conflict; excluded |

`CalendarPort` abstracts the sink today ([src/ports/calendar-port.ts](../../src/ports/calendar-port.ts)); the read-back adds a **free/busy read** capability to the port (new method, e.g. `busy(range)`), implemented per provider — still adapter work, not a rewrite.

### 3a. OPEN design sub-decision **DS1** — pooled capacity ↔ calendar free/busy *(NOT decided; needs the first clinic's real workflow)*
Pooled capacity is a **counter of N chairs**; calendar free/busy is **busy intervals on a calendar**, which don't carry "how many chairs". Candidate conventions:
- **Option A — dedicated recepia calendar, 1 event = 1 chair.** Clean for recepia-written events; but external busy lives on *other* calendars and still doesn't say how many chairs it consumes.
- **Option B (v1 simplification) — any external busy = "whole clinic busy" for that interval** (subtract full capacity / mark slot unavailable). Simplest and **safe** (never double-books), but **over-blocks** (one dentist's personal event blocks all chairs).
- **Option C — one calendar per chair**, free/busy maps 1:1 to a seat. Most accurate; **heavy onboarding** (clinic maintains N calendars) and fights the pooled simplicity.
- **Tradeoff summary:** B = simplest/safe/over-blocks; C = accurate/heavy; A = middle. **Recommend deciding with the first clinic**, after seeing how they actually block time. Left **open**.

### 3b. ⚠️ MVP correction note (affects the CURRENT single-tenant build, not only 003)
Today `get_availability` reads **Postgres only** ([src/tools/get-availability.ts](../../src/tools/get-availability.ts)) — so if the dentist blocks time **directly in her Google Calendar** (off-platform), recepia still offers that slot → **double-booking**. This is a real correctness gap in the **current MVP**, surfaced by the reconciliation decision. **Do NOT build the read-back now** (YAGNI + we need the real workflow): **validate the actual operational model with the first clinic during the pilot/consult** (do they book off-platform? how? on which calendar?), and only then implement read-back. Track it as a **task conditioned on that validation** (relates to 002 deferred items; not started).

---

## 4. Tenant segregation  *(reflects D5 + D3)*

- **Inbound routing → tenant.** Cloud API webhook carries `entry[].changes[].value.metadata.phone_number_id` → tenant; Evolution maps by instance. One endpoint, resolve tenant, then `handleInbound(depsForTenant, msg)`. Our `cloud-api-parser` currently **drops** `metadata` ([src/adapters/messaging/inbound/cloud-api-parser.ts](../../src/adapters/messaging/inbound/cloud-api-parser.ts)) — it would surface `phone_number_id`.
- **Data isolation (D5): shared DB + `tenant_id` + Postgres RLS.** Add `tenant_id` to `booking`, `capacity_rule`, `capacity_override`, `conversation_state`, `patient_consent`, `audit_log`. No-overbooking index → **`unique(tenant_id, start_ts, seat)`**. `conversation_state`/consent keyed by **`(tenant_id, phone)`** (same patient may use multiple clinics). RLS policies `USING (tenant_id = current_setting('app.current_tenant')::uuid)`.
  - **Gotcha (record):** set the tenant with **`SET LOCAL app.current_tenant` per transaction** so it never leaks across pooled connections — **special care with PgBouncer in transaction mode** (transaction-scoped GUC, not session). **[a confirmar]** at impl.
  - DB-per-tenant / schema-per-tenant **only** if a large client demands physical isolation.
- **Config & secrets (D3): application-level encryption.** Per-tenant tokens encrypted **in the app** (libsodium/age), with the encryption key stored as a **Fly secret** — **not** pgcrypto alone (key sitting next to the DB doesn't protect against a DB dump). **External KMS** is a future upgrade if compliance/scale demands. Secrets live in the `tenant` registry (encrypted columns), never in env or plaintext.
- **Composition.** `buildAgentDeps(tenantId)` becomes a factory: resolve tenant → decrypt secrets → build ports. Repos take `tenant_id` or rely on the RLS GUC.
- **LGPD.** Each clinic is an **independent data controller**; consent per `(tenant_id, phone)`; RLS makes "clinic A never sees clinic B" a DB-level guarantee. Ties to 002's deferred retention task (T222).

---

## 5. Onboarding funnel (the "fast & friendly" floor)  *(updated for reconciliation)*

| Step | Clinic action | Clicks | Data typed |
|---|---|---|---|
| 1. Sign up | Email / Google login | ~2 | clinic name, admin email |
| 2. **Connect WhatsApp** | Embedded Signup (FB login → pick/create WABA → pick/add number) | ~5 (Meta UI) | **nothing typed to us** — we get code→token |
| 3. **Connect calendar (Google)** | 1-click OAuth consent (read+write) | ~3 | none |
| 4. Schedule config | Confirm weekly hours grid (prefilled defaults), appointment types (defaults: avaliação/limpeza/retorno/consulta), reception number, timezone (auto) | a few | reception number; tweak hours |
| 5. Go live | Confirm + send a test message | 1 | none |

**Floor:** **two connections (WhatsApp + Google) + a one-field config** → live in ~3–4 minutes. This *is* the user's north star ("ela só conecta WhatsApp e agenda, nada além"). Note: vs the earlier draft, **Step 3 is no longer skippable** for clinics that book off-platform (reconciliation correctness, §3).

---

## 6. Migration: single-tenant → multi-tenant (evolution, not rewrite)

**003 work:**
- **Schema:** add `tenant_id` (backfill current clinic as a seed tenant); seat unique index includes `tenant_id`; RLS policies; new `tenant` registry table with encrypted secret columns.
- **Calendar read-back (new capability):** extend `CalendarPort` with free/busy read; reconcile in `get_availability`. (Also the MVP-correction in §3b — but conditioned on first-clinic validation.)
- **Webhook:** surface `phone_number_id`/instance → resolve tenant → set RLS context → dispatch. ([src/webhook/dispatch.ts](../../src/webhook/dispatch.ts) stays auth/parse/dedupe.)
- **Composition:** `buildAgentDeps(tenantId)` factory + tenant resolver + secret decryptor.
- **Onboarding service + UI:** Embedded Signup callback, Google OAuth callback, tenant CRUD, config form.

**Cheap now (keep the door open — applies to the CURRENT single-tenant work):**
- When next touching the **schema**, assume a future **`tenant_id`** (don't bake single-clinic assumptions into new columns/indexes).
- Keep **secrets out of source** (already true) — and prefer app-level-encryptable shapes for when they move into the `tenant` table.
- The **webhook already exposes `phone_number_id`** (Cloud) — keep it reachable for future routing; `CalendarPort`/`MessagingPort` already swappable.
- Treat the **calendar read-back gap (§3b) as a known MVP limitation** to validate with clinic #1 — not to build speculatively.

**Do NOT build now (dedicated 003):** RLS, `tenant` table, Embedded Signup, OAuth calendar adapters, free/busy read-back, onboarding UI.

---

## 7. RESOLVED decisions (D1–D7)

- **D1 — Source of truth → RECONCILIATION.** Postgres = engine/holds/atomicity + source of truth for recepia bookings; the clinic calendar = write sink + free/busy read source; availability = capacity − recepia bookings − external busy. *Reason:* recepia coexists with phone/walk-in/manual blocks; a single source would double-book. Requires a constitution amendment (§8).
- **D2 — Calendar role → BIDIRECTIONAL, required (not optional mirror).** Connecting a calendar becomes necessary for correctness. *Reason:* without read-back, off-platform bookings cause double-booking.
- **D3 — Secrets → application-level encryption (libsodium/age), key as a Fly secret.** Not pgcrypto alone; KMS later if needed. *Reason:* protect against DB dump; keep the key out of the database blast radius.
- **D4 — WhatsApp production → official Cloud API (Embedded Signup) ONLY.** Evolution = dev/demo only, never a production default or a clinic's main line. *Reason:* ToS/ban risk; CNPJ is not a barrier (clients are clinics).
- **D5 — Isolation → shared DB + `tenant_id` + RLS.** DB/schema-per-tenant only on demand. *Reason:* simplest that scales for many small clinics; RLS gives a DB-level LGPD guarantee. (Gotcha: `SET LOCAL` per tx; PgBouncer care — §4.)
- **D6 — Calendar providers v1 → Google only.** Outlook when a real clinic asks (adapter, not speculative); Apple/Calendly out. *Reason:* YAGNI; Google + Graph both support free/busy read (fits D1/D2).
- **D7 — Business verification → require CNPJ + Meta verification per clinic.** *Reason:* every clinic has a CNPJ; not a blocker. **[a confirmar at spec time]:** the pre-verification sending tier (can the clinic send a test before verification completes?) and go-live timing.

### Remaining open (design sub-decisions, deliberately deferred)
- **DS1 — pooled capacity ↔ calendar free/busy mapping** (Options A/B/C, §3a) — decide with the first clinic's real workflow.
- **D7 follow-ups** — the two `[a confirmar]` items above.

---

## 8. Proposed constitution amendment (DRAFT — apply later via `/speckit.constitution` when approved; NOT applied here)

> Replace, in [.specify/memory/constitution.md](../../.specify/memory/constitution.md) → *Restrições de Domínio*, the line **"Google Calendar é a fonte de verdade dos eventos confirmados; Postgres guarda capacidade, holds e estado de sync"** with:
>
> *"O agendamento segue um modelo de **reconciliação**: o **Postgres é o motor de booking** — fonte da verdade dos agendamentos feitos pelo recepia, dos holds e da garantia atômica de não-overbooking. A **agenda da clínica (ex.: Google Calendar) é bidirecional**: recebe a escrita dos agendamentos confirmados (sink) e é lida como fonte de **free/busy** para descontar ocupações criadas fora do recepia (telefone, balcão, bloqueio manual). A **disponibilidade oferecida = capacidade configurada − agendamentos do recepia − ocupações externas lidas da agenda**. Nenhuma fonte isolada é autoritativa sobre a disponibilidade; a garantia estrutural anti-overbooking no Postgres é mantida."*
>
> Rationale to record in the amendment: recepia coexists with other booking channels, so a single source of truth would either ignore off-platform bookings (double-booking) or force the clinic to abandon its own calendar. This preserves the no-overbooking jewel while reflecting reality.

---

## 9. Sources (official, consulted)
- WhatsApp Embedded Signup overview — https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview/
- Onboarding customers as a Tech Provider — https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider *(JS-rendered; step params **[a confirmar]**)*
- Become a Tech Provider — https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers
- Access Tokens (Business Integration System User token) — https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens/
- Manage accounts / shared WABAs — https://developers.facebook.com/docs/whatsapp/embedded-signup/manage-accounts/
- Partner-initiated WABA creation — https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/partner-initiated-waba-creation
- Messaging limits / verification — https://developers.facebook.com/docs/whatsapp/messaging-limits/
- Google Calendar FreeBusy (read-back) — https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query
- Microsoft Graph permissions reference — https://learn.microsoft.com/en-us/graph/permissions-reference
- Microsoft Graph create event — https://learn.microsoft.com/en-us/graph/api/calendar-post-events?view=graph-rest-1.0
- Apple — app-specific passwords / iCloud in third-party apps — https://support.apple.com/en-us/102654 · https://support.apple.com/en-us/121539
- Calendly OAuth 2.0 + scopes — https://developer.calendly.com/api-docs/3cefb59b832eb-calendly-o-auth-2-0 · https://developer.calendly.com/scopes
- Twilio WhatsApp Sandbox (no-verification dev path) — https://www.twilio.com/docs/whatsapp/sandbox

> **Next step (when you choose):** 003 stays on hold until clinic #2 is real. When resumed: apply the §8 amendment via `/speckit.constitution`, then run `/speckit.specify` for 003 using this decided discovery + resolve DS1 with the first clinic. No implementation until then.
