<!--
Sync Impact Report
==================
Version change: TEMPLATE → 1.0.0
Modified principles: N/A (ratificação inicial)
Added sections:
  - Core Principles (I. Test-First, II. A LLM Nunca Escreve, III. Simplicidade & YAGNI,
    IV. Escalar na Dúvida, V. Rastreabilidade & LGPD)
  - Restrições de Domínio
  - Governance
Removed sections: none
Templates requiring updates:
  - .specify/templates/plan-template.md (Constitution Check deve referenciar os 5 princípios)
Follow-up TODOs: none
-->

# Constituição — Agente de Agendamento Odontológico

Projeto: agente de WhatsApp que agenda consultas de rotina de forma autônoma para uma
clínica odontológica, gravando na agenda (Google Calendar), e escala para humano tudo
que sai do escopo. Vende-se em cima de redução de faltas (no-show).

## Core Principles

### I. Test-First (NON-NEGOTIABLE)

TDD é obrigatório para toda a lógica de domínio — capacidade, disponibilidade, hold,
booking. O ciclo é estrito:

1. Teste escrito e revisado.
2. Teste falha (RED) — confirma que mede algo real.
3. Implementação mínima para passar (GREEN).
4. Refatoração com a suíte verde (REFACTOR).

A camada de conversa (LLM) é validada por testes de comportamento sobre as ferramentas
que ela chama, não pela saída textual. Obrigatório: teste de concorrência provando que
holds simultâneos no mesmo horário nunca geram overbooking.

**Rationale**: o core é correção-crítico (concorrência, contexto de saúde). Sem testes
primeiro, race conditions e regressões passam silenciosas até falhar na frente do paciente.

### II. A LLM Nunca Escreve (NON-NEGOTIABLE)

A LLM conduz a conversa e decide a intenção, mas **todo commit** (agendar, remarcar,
cancelar, gravar no Calendar) passa exclusivamente pelas ferramentas determinísticas.
A LLM propõe; o código valida e executa. `get_availability` é a única fonte de horário —
nenhum horário pode vir da memória do modelo.

**Rationale**: separa a parte não-determinística (linguagem) da parte que exige garantia
(escrita). É o que torna a autonomia segura o suficiente para demonstrar.

### III. Simplicidade & YAGNI

Implemente apenas o que a spec da feature atual exige. Proibido:

- Abstrações para casos hipotéticos.
- Camadas extras (port, adapter, factory) sem dois consumidores reais. (Exceção válida:
  `MessagingPort` tem dois — Evolution e Cloud API; `CalendarPort` isola a integração testável.)
- Generalização preventiva antes da terceira ocorrência do padrão.

Nada do Não-escopo (calendário por dentista, roteamento por especialidade, otimização de
agenda, integração com software odontológico, pagamentos) entra sem spec dedicada.

**Rationale**: complexidade prematura é a maior fonte de retrabalho num projeto novo.

### IV. Escalar na Dúvida (NON-NEGOTIABLE — segurança clínica)

O agente nunca inventa horário, convênio, preço ou informação clínica. Escala para humano
em qualquer dúvida, ambiguidade, urgência/dor, procedimento especializado (Invisalign,
ortodontia, implante, cirurgia), tratamento em andamento, pedido de dentista específico,
reclamação ou assunto financeiro. Antes de qualquer commit de agendamento, exige
confirmação explícita do paciente.

**Rationale**: em saúde, errar com confiança é pior que escalar. A rede de escalação é o
que torna a autonomia aceitável.

### V. Rastreabilidade & LGPD (NON-NEGOTIABLE)

Toda escrita registra em `audit_log` (append-only). Dado de saúde é categoria sensível:
opt-in claro, opt-out fácil, coleta mínima, finalidade definida. Sem uso para marketing
sem consentimento.

**Rationale**: exigência legal e diferencial de venda. Sem trilha de auditoria não há
como provar conformidade nem depurar uma marcação errada.

## Restrições de Domínio

- Modelo de capacidade pooled: paciente não escolhe dentista; disponibilidade é um contador
  de capacidade, não casamento de recursos. Modo `assigned` fica fora do escopo até spec dedicada.
- Google Calendar é a fonte de verdade dos eventos confirmados; Postgres guarda capacidade,
  holds e estado de sync. Nenhuma chamada direta a Calendar ou WhatsApp sem camada testável
  intermediária (port).
- O agente atende apenas tipos de consulta de rotina. Qualquer outro tipo é escalado.
- Toda string visível ao paciente é em português.

## Governance

Esta constituição prevalece sobre preferências pessoais ou convenções herdadas de outros
projetos. Cumprir todos os princípios é gate explícito no `/speckit.plan`.

Mudanças seguem versionamento semântico e passam por `/speckit.constitution` — edição manual
quebra o Sync Impact Report e a propagação para templates dependentes.

**Version**: 1.0.0 | **Ratified**: 2026-06-18 | **Last Amended**: 2026-06-18