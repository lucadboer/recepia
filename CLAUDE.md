# CLAUDE.md — Agente de Agendamento Odontológico

## Contexto do projeto

Agente de WhatsApp que **agenda consultas de rotina de forma autônoma** para uma clínica odontológica, gravando na agenda (Google Calendar), e **escala para humano** tudo que sai do escopo. Vende-se em cima de redução de faltas (no-show). O projeto é conduzido por **Spec Driven Development (SDD)** usando o **GitHub Spec Kit**, com **Claude Code** como agente.

## Como conduzir o trabalho

Toda nova feature começa por uma spec em `specs/NNN-feature/spec.md`, gerada por `/speckit.specify` a partir do `SPEC.md`. Código sem spec correspondente deve ser revertido em review.

O fluxo canônico é `/speckit.specify` → `/speckit.clarify` → `/speckit.plan` → `/speckit.tasks` → `/speckit.analyze` → `/speckit.implement`. Pular etapas costuma gerar retrabalho.

Decisões de produto vão para a spec. Decisões técnicas (stack, arquitetura) vão para o plano. Não misture.

## Fonte primária da verdade

Os artefatos abaixo são autoritativos. Em conflito com qualquer outro contexto, eles vencem.

- [.specify/memory/constitution.md](.specify/memory/constitution.md) — princípios não-negociáveis. Prevalece sobre tudo.
- [SPEC.md](SPEC.md) — o quê e o porquê do MVP (user stories, modelo de dados, contratos das ferramentas).
- `specs/NNN-feature/plan.md` — stack, arquitetura e estrutura.
- `specs/NNN-feature/tasks.md` — sequência de execução.

## Referência de boas práticas (somente leitura)

O repositório do POS de Engenharia de Software com IA Aplicada serve de **referência de formato e método** (SDD, Spec Kit, padrão de contrato, exemplo trabalhado). É referência, **não código a copiar** — nada do domínio dele (catálogo Netflix) entra aqui. Ajuste o caminho se necessário.

- `../engenharia-de-software-com-ia-aplicada/lives/2026-05-27/001-pos-live/` — exemplo trabalhado completo (spec, plan, data-model, contracts, checklists).
- `.../001-pos-live/specs/001-catalog-browse/contracts/catalog-service.md` — padrão de contrato (API + Garantias + Testes obrigatórios).
- `.../000-pre-live/.specify/templates/` — templates de spec, plan, tasks, constitution.
- `../engenharia-de-software-com-ia-aplicada/lives/2026-02-24/base-teorica/` — base teórica de MCP e Agent Skills.

Em dúvida sobre fluxo ou comando do Spec Kit, leia a skill correspondente em `.claude/skills/` em vez de adivinhar.

## Princípios não-negociáveis (resumo executável)

Detalhes completos na [constituição](.specify/memory/constitution.md). Cumprir todos é gate explícito no `/speckit.plan`.

1. **Test-First (NON-NEGOTIABLE)**. TDD para toda lógica de domínio. Obrigatório: teste de concorrência provando que holds simultâneos no mesmo horário nunca geram overbooking.
2. **A LLM nunca escreve (NON-NEGOTIABLE)**. A LLM propõe; só as ferramentas determinísticas gravam. `get_availability` é a única fonte de horário.
3. **Simplicidade & YAGNI**. Sem abstração antes de dois consumidores reais. Nada do Não-escopo sem spec dedicada.
4. **Escalar na dúvida (NON-NEGOTIABLE)**. Nunca inventar horário, convênio, preço ou info clínica. Escalar ambiguidade, urgência, procedimento especializado, tratamento em andamento. Confirmação explícita antes de qualquer commit.
5. **Rastreabilidade & LGPD (NON-NEGOTIABLE)**. `audit_log` de toda escrita. Opt-in/opt-out, coleta mínima.

## Restrições de domínio

- Modelo de capacidade **pooled**: paciente não escolhe dentista; disponibilidade é contador de capacidade, não casamento de recursos. Modo `assigned` fica fora do escopo.
- Google Calendar = fonte de verdade dos eventos confirmados. Postgres = capacidade, holds, estado de sync. Nenhuma chamada direta a Calendar ou WhatsApp sem port testável (`CalendarPort`, `MessagingPort`).
- O agente atende só consultas de **rotina**. Qualquer outro tipo é escalado.
- Toda string visível ao paciente é em português.

## Regras de operação

- Não edite arquivos em `.specify/templates/`, `.specify/scripts/`, `.specify/workflows/`, nem `.claude/skills/`, exceto quando um comando do Spec Kit instruir. São infraestrutura do framework.
- Antes de mudar a [constituição](.specify/memory/constitution.md), invoque `/speckit.constitution`. Edição manual quebra o Sync Impact Report.
- Construa a camada determinística com testes **antes** de plugar a LLM. Integrações (Calendar, WhatsApp) atrás de ports, com fakes nos testes.
- Erros de booking são explícitos e tratáveis (ex.: `SlotUnavailableError`), nunca silenciosos.
- Ao referenciar arquivos em respostas, use links markdown clicáveis `[texto](caminho)`.

<!-- SPECKIT START -->
**Features**: `001-autonomous-routine-booking` (deterministic booking foundation, no overbooking) and `002-conversational-orchestration` (Claude tool-use orchestrator, including the Phase 11 hardening: handed-off state, transactional outbox, optimistic concurrency, IANA timezone, bounded state, webhook hardening) are **complete**. `003-multi-tenant-onboarding` is research only. Next slices (portfolio plan): 004 evaluation harness, 005 observability & cost, 006 durable inbound pipeline, then Dockerfile/deploy, MCP server, 003 RLS.

Stack: TypeScript on Node 24 (engines ≥ 22.12 — vitest 5 and googleapis 183 need it; `.node-version` pins 24), **pnpm** (via Corepack) + **tsx**, PostgreSQL via `pg`, **Vitest** (v8 coverage thresholds), **Biome**. The LLM proposes; the deterministic 001 tools remain the **only writers** ("A LLM nunca escreve" — enforced structurally by 3 gates in `src/agent/tool-registry.ts`). LLM/Calendar/WhatsApp sit behind ports (`LLMPort`, `CalendarPort`, `MessagingPort`, `Clock`, `ConversationStorePort`) with in-memory fakes; the real adapters (`AnthropicLLM`, `GoogleCalendar`, `CloudApiMessaging`, `EvolutionMessaging`) are full implementations that fail fast with `NotConfigured` without credentials and are exercised by `tests/live` behind `LIVE_*` flags. The conversation layer is validated by **behavioral tests over the tools it calls, not LLM text**. Dependency policy and CI gates: [CONTRIBUTING.md](CONTRIBUTING.md). Technical decisions: [docs/adr/](docs/adr/README.md).

For full technical context, read the 002 plan (incl. the "Hardening addendum") plus `spec.md`, `data-model.md`, and `contracts/`; the deterministic surface lives under specs/001.
<!-- SPECKIT END -->
