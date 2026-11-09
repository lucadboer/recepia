<!--
Sync Impact Report
==================
Version change: 1.0.0 → 1.1.0
Bump rationale: MINOR — the whole document is translated to English (wording only, no principle,
  gate or rule changes meaning) and one domain constraint is added: code and documentation are
  in English (owner decision 2026-11-09).
Modified principles (titles translated, content unchanged):
  - II. A LLM Nunca Escreve → II. The LLM Never Writes
  - III. Simplicidade & YAGNI → III. Simplicity & YAGNI
  - IV. Escalar na Dúvida → IV. Escalate When in Doubt
  - V. Rastreabilidade & LGPD → V. Traceability & LGPD
Renamed sections: Restrições de Domínio → Domain Constraints
Added sections: none (one bullet added to Domain Constraints)
Removed sections: none
Templates requiring updates:
  - ✅ .specify/templates/plan-template.md — generic "Constitution Check", no principle names
  - ✅ .specify/templates/spec-template.md — no constitution-specific content
  - ✅ .specify/templates/tasks-template.md — no constitution-specific content
  - ✅ CLAUDE.md — executable summary translated in the same change
Follow-up TODOs: none
-->

# Constitution — dental appointment booking agent

Project: a WhatsApp agent that books routine appointments autonomously for a dental clinic,
writing them to the clinic's calendar (Google Calendar), and escalates to a human everything out
of scope. It is sold on no-show reduction.

## Core Principles

### I. Test-First (NON-NEGOTIABLE)

TDD is mandatory for all domain logic — capacity, availability, hold, booking. The cycle is
strict:

1. Test written and reviewed.
2. Test fails (RED) — proving it measures something real.
3. Minimal implementation to pass (GREEN).
4. Refactor with the suite green (REFACTOR).

The conversation layer (LLM) is validated by behavioural tests over the tools it calls, not by
its text output. Mandatory: a concurrency test proving that simultaneous holds on the same time
never overbook.

**Rationale**: the core is correctness-critical (concurrency, a health context). Without tests
first, race conditions and regressions stay silent until they fail in front of a patient.

### II. The LLM Never Writes (NON-NEGOTIABLE)

The LLM leads the conversation and decides the intent, but **every commit** (book, reschedule,
cancel, write to the Calendar) goes exclusively through the deterministic tools. The LLM
proposes; the code validates and executes. `get_availability` is the only source of times — no
time may come from the model's memory.

**Rationale**: it separates the non-deterministic part (language) from the part that needs
guarantees (writes). That is what makes the autonomy safe enough to demonstrate.

### III. Simplicity & YAGNI

Implement only what the current feature's spec requires. Forbidden:

- Abstractions for hypothetical cases.
- Extra layers (port, adapter, factory) without two real consumers. (Valid exception:
  `MessagingPort` has two — Evolution and the Cloud API; `CalendarPort` isolates the testable
  integration.)
- Pre-emptive generalisation before the pattern's third occurrence.

Nothing from the out-of-scope list (per-dentist calendars, routing by speciality, schedule
optimisation, integration with dental practice software, payments) goes in without a dedicated
spec.

**Rationale**: premature complexity is the biggest source of rework in a new project.

### IV. Escalate When in Doubt (NON-NEGOTIABLE — clinical safety)

The agent never invents a time, insurance, price or clinical information. It escalates to a
human on any doubt, ambiguity, urgency/pain, specialised procedure (Invisalign, orthodontics,
implant, surgery), ongoing treatment, request for a specific dentist, complaint or financial
matter. Before any booking commit it requires the patient's explicit confirmation.

**Rationale**: in health care, being confidently wrong is worse than escalating. The escalation
safety net is what makes the autonomy acceptable.

### V. Traceability & LGPD (NON-NEGOTIABLE)

Every write is recorded in `audit_log` (append-only). Health data is a sensitive category: clear
opt-in, easy opt-out, minimal collection, a defined purpose. No marketing use without consent.

**Rationale**: a legal requirement and a selling point. Without an audit trail there is no way to
prove compliance or to debug a wrong booking.

## Domain Constraints

- Pooled capacity model: the patient does not choose a dentist; availability is a capacity
  counter, not resource matching. The `assigned` mode is out of scope until a dedicated spec.
- Google Calendar is the source of truth for confirmed events; Postgres keeps capacity, holds and
  sync state. No direct call to the Calendar or WhatsApp without an intermediate testable layer
  (a port).
- The agent handles routine appointment types only. Any other type is escalated.
- Every string a patient sees is in Brazilian Portuguese.
- Code and documentation are in English.

## Governance

This constitution prevails over personal preferences or conventions inherited from other
projects. Meeting every principle is an explicit gate in `/speckit.plan`.

Changes follow semantic versioning and go through `/speckit.constitution` — editing by hand
breaks the Sync Impact Report and the propagation to dependent templates.

**Version**: 1.1.0 | **Ratified**: 2026-06-18 | **Last Amended**: 2026-11-09
