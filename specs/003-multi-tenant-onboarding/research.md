# Phase 0 Research (DECIDED): Multi-Tenant Onboarding — `003-multi-tenant-onboarding`

> **Status: discovery; decisions D1–D11 RESOLVED.** Still **not a spec** and **no code** — 003 stays on hold until a real 2nd clinic exists (YAGNI, constitution III). This doc records the resolved product direction and the concrete *HOW* questions for the spec. External claims are cited (§10); unverified bits are **[a confirmar]**. The constitution is **not** edited here — **two** proposed amendments are drafted (§9) to apply later via `/speckit.constitution`.
>
> **Product north star (decided):** a clinic **self-serves**: creates an account, logs in, connects WhatsApp + their calendar, and **configures its own hours, professionals, and procedures** — with **no manual step from us**. Two third-party review gates (Meta + Google) make "same-day go-live" unrealistic (§2, §3).

## 0. What changes vs today (single-tenant)
Today recepia is single-tenant: one Postgres, one Google Calendar, one WABA, one `receptionPhone`, all from one `.env`. `buildAgentDeps()` ([src/composition.ts](../../src/composition.ts)) reads one clinic; the webhook ([src/webhook/server.ts](../../src/webhook/server.ts)) routes every inbound to one `handleInbound`. Ports (`CalendarPort`, `MessagingPort`, `Clock`) are injected — the lever that makes multi-tenant an **evolution, not a rewrite** (§7). **Note:** the capacity model also changes from **pooled** to **resource-based** (§4, D10) — a deeper change than multi-tenancy alone.

---

## 1. Self-service onboarding (D8) — the clinic does it alone
The clinic signs up, logs in, and connects everything itself; we never hand-configure a tenant. Three self-service connect/config steps:
- **Connect WhatsApp** via Embedded Signup (§2).
- **Connect calendar** via Google 1-click OAuth (§3).
- **Self-configure** hours / professionals / procedures via our UI (§5, D9).

The two account logins the clinic needs: a **Meta Business** account (for WhatsApp — §2) and a **Google** account (for calendar — §3). Clinics without a Meta Business account must create one — **that is part of onboarding, documented honestly, not hidden**.

---

## 2. WhatsApp per clinic — Tech Provider + Embedded Signup (D4 + D11)

**Our one-time prerequisites (provider side).** Become a **Tech Provider**: verify **our** business, and pass **App Review** to get **Advanced Access** to `whatsapp_business_messaging` (send on behalf of clients) + `whatsapp_business_management` (clients' WABA settings + templates) ([Become a Tech Provider]). App Review requires a **screencast** demonstrating the permission's use — e.g. a recording of the API Setup cURL **sending a message**, and/or **WhatsApp Manager creating a template** ([App Review sample submission]). After verification + App Review + Access Verification, our customer-onboarding limit rises to **200 new business customers / rolling 7 days** ([Solution Providers]).
- **⚠️ Build on Embedded Signup v4.** **Embedded Signup v2 is deprecated 2026-10-15** — migrate to **v4** ([Embedded Signup overview]). **[a confirmar]** the exact v4 flow params (auth response `code`, session config) at spec time.

**The clinic's flow (irreducible — honest).**
1. The clinic **authenticates with THEIR own Meta/Facebook Business account** — there is **no Embedded Signup without a Meta login**. Clinics without one must create it (part of onboarding).
2. They authorize **their WABA**, and **pick or migrate a phone number**. We exchange the returned `code` → a **Business Integration System User token** (no re-auth) ([Access Tokens]); resolve the WABA id via Debug Token ([Manage accounts]).
3. **The clinic must add a PAYMENT METHOD (card) to their WABA.** For **Tech Providers**, "clients onboarded by Tech Providers must provide their own payment method after onboarding" ([Pricing]). **This is a business-model fact:** the clinic **pays Meta directly** for WhatsApp usage, **on top of** what they pay us. WhatsApp pricing is **per-message** (charged per delivered template message) **since 2025-07-01** ([Pricing]). *(Contrast: a **Solution Partner** can extend its own credit line so clients don't enter payment — a different partner type we are NOT choosing for v1; [a confirmar] if worth revisiting.)*
4. **Business verification timeline:** varies by region; can take **days to weeks** — onboarding is **not** "live the same day." **[a confirmar]** Meta publishes no fixed SLA.
5. **Number already used in the WhatsApp Business app:** migration is supported but needs a **customized Embedded Signup flow** ("Onboard WhatsApp Business app users") — **[a confirmar]** the exact steps/screens ([Onboard WhatsApp Business app users]).

**Routing:** the webhook payload's `metadata.phone_number_id` → maps to the tenant (§7).

**Dev/test without real clinics:** Meta **sandbox accounts are valid 30 days** (then deactivated/reclaim) — use them to build/QA the Embedded Signup integration ([Solution Providers]).

**D4 reaffirmed:** production is **always** official Cloud API via Embedded Signup. **Evolution/Baileys is dev/demo only — never production**, never a clinic's main line (ToS/ban risk).

---

## 3. Calendar — reconciliation model + Google OAuth (D1 + D2 + D6, extended)

**Decided operating model: recepia COEXISTS with other booking channels** (phone, walk-in, manual blocks). recepia is **not** the exclusive owner of the agenda:
- **Postgres is the booking ENGINE + source of truth** for recepia's own bookings + holds + the atomic no-overbooking guarantee (kept — the jewel).
- **The clinic's calendar is BIDIRECTIONAL:** write sink (push confirmed) **+** read source (free/busy) to subtract occupations made outside recepia.
- **Availability = reconciliation:** `free = capacity − recepiaBookings [Postgres] − externalBusy [calendar free/busy]`. Connecting a calendar is **necessary** (not cosmetic) for any clinic that books off-platform (≈ all).

**Per-clinic linking = 1-click Google OAuth (D8).** Replaces the current single-tenant Service-Account-share. Flow:
`"Conectar Google Agenda" → consent on THEIR Google account → code → exchange for refresh token → store ENCRYPTED per tenant (D3) → server reads free/busy + writes events with their token.`

**⚠️ NEW gate found — Google OAuth app verification.** Calendar scopes (`calendar.events` for write, plus `calendar.readonly`/`calendar.freebusy` for free/busy read) are **sensitive/restricted** → require **Google's OAuth app verification** before any Google account can grant access in production ([Google sensitive-scope verification], [Choose Calendar scopes]). So there are **TWO review gates** at onboarding: **Meta** (§2) **and** **Google**. **[a confirmar]** the exact least-privilege scope set (events-write + free/busy-read).
- **⚠️ 7-day refresh-token trap:** while the OAuth consent screen is in **"Testing"** publishing status, refresh tokens **expire in 7 days** ([OAuth web-server / policies]). Production REQUIRES the app **published + verified**, else per-clinic tokens die weekly. Also: a refresh token dies if the user **revokes** or it's **unused for 6 months** — the adapter must handle re-auth.

**Provider matrix (D6: Google only in v1).**

| Provider | v1? | 1-click OAuth | Free/busy read | Notes |
|---|---|---|---|---|
| **Google Calendar** | ✅ v1 | ✅ (needs Google app verification) | ✅ FreeBusy API | We already speak it (002) |
| **Microsoft 365 / Outlook** | ⏳ on demand | ✅ (`offline_access`, `Calendars.ReadWrite`) | ✅ getSchedule | Adapter when a clinic asks (YAGNI) |
| **Apple / iCloud** | ❌ out | ❌ (CalDAV + app-specific password) | — | High friction |
| **Calendly** | ❌ out | ⚠️ | — | Competing scheduler / model conflict |

`CalendarPort` gains a **free/busy read** method (e.g. `busy(range, resourceRef)`), implemented per provider — adapter work, not a rewrite.

### 3a. ⚠️ MVP correction note (affects the CURRENT single-tenant build)
Today `get_availability` reads **Postgres only** ([src/tools/get-availability.ts](../../src/tools/get-availability.ts)) — a dentist blocking time **directly in Google Calendar** is **not** seen → recepia could **double-book**. Real gap in the current MVP. **Do NOT build read-back speculatively** — validate the real workflow with clinic #1, then implement. (DS1 below is largely answered by the resource-based model.)

---

## 4. Capacity model: POOLED → RESOURCE-BASED (per professional/specialty) — **D10, the deep change**

**Decided target model.** The clinic registers **professionals**, each with **specialties**, and booking respects them — e.g. one does only ortho/aparelho, another only consultation/initial eval, another only surgery. This **replaces the pooled "N generic chairs"** model. **This contradicts the current constitution** ("Modelo de capacidade pooled… Modo `assigned` fica fora do escopo até spec dedicada") → **needs a constitution amendment (§9).** It is also what the constitution foresaw as "a dedicated spec" — this is that spec's direction.

**Concretely, what changes (not trivial):**
- **Data model.** New `professional` (id, name, specialties[]) and `procedure_type`; an M:N **procedure → qualified professionals** mapping; **per-professional working schedule** (today's `capacity_rule` becomes per-professional, not a single pooled counter); `booking` gains `professional_id`.
- **No-overbooking guarantee evolves but stays structural.** From `unique(start_ts, seat)` (pooled seats) → effectively **`unique(professional_id, start_ts)` for active states** (a professional can't hold two bookings at once). Plus `tenant_id` (§7) → `unique(tenant_id, professional_id, start_ts)`. The advisory-lock + atomic-recheck pattern carries over per professional.
- **`get_availability` resolves PER professional.** For procedure P: find professionals qualified for P → union of each one's free slots (their schedule − their bookings − their holds − **their** external free/busy). Replaces the single capacity counter.
- **Reconciliation becomes PER professional (this answers DS1).** External free/busy is read **per professional** — ideally **each professional's own calendar** maps 1:1 to that professional's availability, removing the old pooled "how many chairs does this busy block consume?" ambiguity. Trade-off: **N calendar connections per clinic** (one per professional) vs **one shared calendar with per-professional sub-calendars/labels**. **[a confirmar / design]** which we support v1.
- **Triage (001) becomes DATA-DRIVEN, not a fixed blocklist.** Today aparelho/ortodontia/implante/cirurgia **always escalate** (out of routine scope). With specialized professionals registered, those procedures become **auto-bookable for the qualified professional**. So the rule flips: **escalate procedures the clinic does NOT support** (no qualified professional configured); **keep escalating** urgency/pain, ambiguity, complaints, financial, ongoing-treatment, specific-doubt (the safety net stays). The clinic's procedure config drives what's bookable vs escalated.

**Implementation questions for the spec (HOW, not IF):**
1. Does the patient **choose/see the professional** ("com a Dra. X") or stays abstracted ("ter 14h livre")? (UX + privacy.)
2. **One calendar per professional** vs **one clinic calendar with markers** for free/busy read — what do we require/support v1?
3. How do **procedure→specialty→professional** mappings get modeled and edited in the self-config UI (§5)?
4. Per-professional schedule + clinic-wide overrides (holidays) — precedence rules.
5. How does triage read the clinic's "supported procedures" set to decide auto-book vs escalate, **without ever weakening the escalate-on-doubt non-negotiable**?
6. Migration of the seat model → resource model in the schema (the 001 concurrency/anti-overbooking tests must stay green, re-cast per professional).

---

## 5. Self-configuration UI (D9) — essential product surface
After login, the clinic configures **itself**, via an interface:
- **(a) Working hours** it operates (weekly grid + overrides/holidays).
- **(b) Professionals available** and **how many** — each with their specialties (feeds D10).
- **(c) Procedure types** it offers, mapped to qualifying professionals (feeds D10 + the triage data-drive).

This UI is **core product**, not nice-to-have — it's what lets each clinic mirror its own way of working without us touching anything. It writes the tenant's `professional` / `procedure_type` / per-professional `capacity_rule` rows.

---

## 6. Onboarding funnel (updated for self-service + two review gates)

| Step | Clinic action | Note |
|---|---|---|
| 1. Sign up + log in | Email/Google login; create Meta Business acct if absent | self-service |
| 2. Connect WhatsApp | Embedded Signup v4 (Meta login → authorize WABA → pick/migrate number → **add payment method**) | **Meta verification gate (days–weeks)** |
| 3. Connect calendar | Google 1-click OAuth (free/busy-read + events-write + offline) | **Google app-verification gate** |
| 4. Self-configure (§5) | hours · professionals+specialties · procedures | the UI |
| 5. Go live | test message | after both gates clear |

**Honest expectation:** the *clicks* are minutes, but **go-live is gated by Meta business verification (days–weeks) and Google OAuth app verification** — not same-day. The clinic also takes on a **direct Meta bill** (per-message).

---

## 7. Tenant segregation (D5 + D3) — unchanged direction
- **Routing:** webhook `phone_number_id` → tenant (Cloud); Evolution instance → tenant (dev). `cloud-api-parser` currently drops `metadata` → would surface `phone_number_id`.
- **Isolation (D5):** shared DB + `tenant_id` on every table + Postgres **RLS** (`USING (tenant_id = current_setting('app.current_tenant')::uuid)`). No-overbooking index now `unique(tenant_id, professional_id, start_ts)` (per D10). `conversation_state`/consent keyed by `(tenant_id, phone)`. **Gotcha:** `SET LOCAL app.current_tenant` per transaction; **PgBouncer transaction-mode care** [a confirmar].
- **Secrets (D3):** per-tenant tokens (WhatsApp + Google refresh) **app-level encrypted** (libsodium/age), key as a **Fly secret**; not pgcrypto alone; KMS later. Stored in a `tenant` registry, never in env/plaintext.
- **Composition:** `buildAgentDeps(tenantId)` factory → resolve tenant → decrypt secrets → build ports.
- **LGPD:** each clinic = independent controller; RLS = DB-level "clinic A never sees clinic B"; consent per `(tenant_id, phone)`.

---

## 8. Migration single-tenant → multi-tenant (+ pooled→resource): evolution, not rewrite
**003 work:** `tenant_id` + RLS + `tenant` registry (encrypted secrets); **professional/procedure_type data model + per-professional schedule + resource-based `get_availability`/`hold_slot`** (D10); calendar **free/busy read-back** per professional; webhook tenant resolution; `buildAgentDeps(tenantId)`; **onboarding service + self-config UI** (Embedded Signup v4 callback, Google OAuth callback, tenant CRUD).
**Cheap now (single-tenant work):** assume a future `tenant_id` when touching schema; keep secrets out of source; webhook already exposes `phone_number_id`; treat read-back gap (§3a) as a known limitation. **Do NOT build** RLS/tenant table/Embedded Signup/OAuth/resource model/UI now.

---

## 9. RESOLVED decisions

**From the first pass (unchanged):** **D1** reconciliation source-of-truth · **D2** calendar bidirectional+required · **D3** app-level secret encryption (Fly key) · **D4** Cloud API only in prod (Evolution dev-only) · **D5** shared DB + `tenant_id` + RLS · **D6** Google-only calendar v1 · **D7** CNPJ + Meta verification per clinic.

**New (this pass):**
- **D8 — Self-service onboarding with clinic login.** Clinic creates account + connects WhatsApp (Embedded Signup) + Google Calendar (1-click OAuth) itself; no manual step from us. Requires the clinic to have/ create a Meta Business account and a Google account.
- **D9 — Clinic self-configuration UI.** The clinic sets its own hours, professionals (+specialties), and procedures via our interface — core product.
- **D10 — Resource-based capacity (per professional/specialty), replacing pooled.** Booking matches procedure→qualified professional; availability/holds/no-overbooking become per professional; triage becomes data-driven (escalate UNSUPPORTED procedures, keep all doubt/urgency escalations). **Needs a constitution amendment (§ below).** Reshapes/answers **DS1** (free/busy maps per professional).
- **D11 — Embedded Signup v4 + Tech Provider model.** One-time provider prereqs: business verification + App Review (screencast of send-message and/or template-create) for Advanced Access. Clinic adds **its own payment method** (clinic pays Meta per-message directly — business-model impact). Build on **v4** (v2 deprecated 2026-10-15). Dev via 30-day sandbox accounts.

**Still open (deferred):** **DS2 [a confirmar]** — one calendar per professional vs one clinic calendar with markers (free/busy granularity, §4). The §4 "HOW" list. Exact v4 Embedded Signup + WA-Business-app-migration steps. Least-privilege Google scope set. PgBouncer/RLS interaction.

---

## 10. Proposed constitution amendments (DRAFT — apply via `/speckit.constitution` when approved; NOT applied here)

**Amendment 1 — source of truth (from D1/D2).** Replace *"Google Calendar é a fonte de verdade dos eventos confirmados; Postgres guarda capacidade, holds e estado de sync"* with the **reconciliation** model: Postgres = engine/holds/atomicity + source of truth for recepia bookings; the clinic calendar = write sink + free/busy read source; `disponibilidade = capacidade − agendamentos recepia − ocupações externas`. No single source is authoritative; the structural anti-overbooking guarantee is kept.

**Amendment 2 — capacity model (from D10).** Replace the **pooled-only** restriction (*"Modelo de capacidade pooled… Modo assigned fica fora do escopo até spec dedicada"*) with a **resource-based** model: the clinic registers professionals with specialties; availability/holds/no-overbooking resolve **per professional**; procedure→professional matching governs what is auto-bookable; escalation stays the default for unsupported procedures and any doubt/urgency. The atomic no-overbooking guarantee is preserved, re-cast per professional. *(This is the "dedicated spec" the current constitution anticipated.)*

---

## 11. Sources (official, consulted)
- WhatsApp Embedded Signup overview (v2 deprecation 2026-10-15 → v4) — https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview
- Become a Tech Provider (Advanced Access) — https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers
- App Review sample submission (screencast: send message / create template) — https://developers.facebook.com/docs/whatsapp/solution-providers/app-review/sample-submission
- Solution Providers overview (payment by partner type; 200/7-day limit; 30-day sandbox) — https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/overview
- Pricing (per-message since 2025-07-01; Tech-Provider clients provide own payment) — https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing
- Onboard WhatsApp Business app users (number migration) — https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users
- Access Tokens (Business Integration System User token) — https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens/
- Google — sensitive/restricted scope verification — https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification
- Google — choose Calendar API scopes — https://developers.google.com/workspace/calendar/api/auth
- Google — OAuth web-server flow / refresh tokens (7-day testing expiry; revoke/6-month) — https://developers.google.com/identity/protocols/oauth2/web-server · https://developers.google.com/identity/protocols/oauth2/policies
- Google Calendar FreeBusy — https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query
- Microsoft Graph (Outlook, on-demand) — https://learn.microsoft.com/en-us/graph/permissions-reference
- Apple app-specific passwords (excluded) — https://support.apple.com/en-us/102654
- Calendly OAuth (excluded) — https://developer.calendly.com/api-docs/3cefb59b832eb-calendly-o-auth-2-0

> **Next step (when resumed):** apply §10 amendments via `/speckit.constitution`, then `/speckit.specify` for 003 using this decided direction; resolve the §4 *HOW* list + DS2 with the first clinic. No implementation until clinic #2 is real.
