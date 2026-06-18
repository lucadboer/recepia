# SPEC — Secretária IA Odontológica (MVP)

> Spec de produto para o MVP. Princípios não-negociáveis em [constitution.md](.specify/memory/constitution.md). Padrão de formato/contrato seguido do repositório do POS (ver `CLAUDE.md` → Referência de boas práticas). Alimenta `/speckit.specify`.

## Objetivo

Uma única feature vendível: **agendamento autônomo de consultas de rotina via WhatsApp**, com escrita real no Google Calendar e confirmação automática. Tudo fora de rotina é escalado para a recepção. A redução de falta (confirmação/lembrete) acompanha o loop de agendamento e é a métrica de ROI do piloto.

---

## User Scenarios & Testing

User stories priorizadas. Cada uma é independentemente testável e entrega valor sozinha.

### User Story 1 — Agendar consulta de rotina (P1)

Paciente manda mensagem no WhatsApp a qualquer hora e marca uma consulta de rotina sozinho; o evento aparece no Google Calendar da clínica.

**Por que P1**: é o core vendável e o demo. Sozinha já justifica o produto (captura fora do horário + libera a recepção).

**Teste independente**: enviar mensagem pedindo horário e verificar que o evento é gravado no Calendar sem intervenção humana e sem overbooking.

**Cenários de aceite**:
1. **Dado** que há capacidade livre em um horário, **quando** o paciente pede para marcar uma limpeza e confirma um horário oferecido, **então** o booking é gravado no Calendar e o paciente recebe confirmação.
2. **Dado** que dois pacientes miram o mesmo horário ao mesmo tempo, **quando** ambos confirmam, **então** apenas um é gravado e o outro recebe horários alternativos (sem overbooking).
3. **Dado** que não há capacidade no período pedido, **quando** o paciente insiste, **então** o agente oferece os próximos horários livres reais.
4. **Dado** um pedido que não é de rotina (ex.: Invisalign), **quando** o paciente envia, **então** o agente escala para a recepção sem tentar marcar.

### User Story 2 — Confirmar consulta / reduzir falta (P2)

Antes da consulta, o agente confirma automaticamente e libera o horário se o paciente desmarcar.

**Por que P2**: gera o número de redução de falta que sustenta o ROI. Depende do loop de booking existir.

**Teste independente**: criar um booking, rodar o job de lembrete e verificar o envio + o processamento de SIM/REMARCAR.

**Cenários de aceite**:
1. **Dado** um booking confirmado 24–48h à frente, **quando** o job roda, **então** o paciente recebe pedido de confirmação.
2. **Dado** o pedido de confirmação, **quando** o paciente responde "SIM", **então** o status vira `patient_confirmed`.
3. **Dado** o pedido de confirmação, **quando** o paciente pede para remarcar, **então** o horário é liberado e entra o fluxo de remarcação.

### User Story 3 — Remarcar e cancelar (P3)

Paciente remarca ou cancela pelo WhatsApp; a capacidade é liberada corretamente.

**Por que P3**: completa o ciclo de vida do agendamento, mas o demo e o ROI já funcionam sem isso.

**Cenários de aceite**:
1. **Dado** um booking existente do paciente, **quando** ele pede para remarcar, **então** o antigo é liberado e o novo é gravado de forma atômica.
2. **Dado** um booking existente, **quando** ele cancela, **então** a capacidade volta a ficar disponível.
3. **Dado** múltiplos bookings ou caso ambíguo, **quando** ele pede mudança, **então** o agente escala para a recepção.

---

## Escopo (IN)

Receber mensagem a qualquer hora; classificar intenção; agendar rotina (avaliação, limpeza, retorno, consulta); consultar disponibilidade real, reservar, confirmar e gravar no Calendar; confirmar/lembrar antes da consulta; escalar fora do escopo; auditar toda escrita.

## Não-escopo (OUT — não construir sem spec dedicada)

Procedimentos especializados (Invisalign, orto, implante, cirurgia → **sempre escalar**); plano multi-sessão; calendário por dentista / escolha de profissional (`scheduling_mode: assigned`); roteamento por especialidade/cadeira; otimização de agenda; integração com software odontológico; pagamentos/financeiro.

## Modelo de capacidade (pooled)

Paciente não escolhe dentista; é atendido por quem estiver livre. Disponibilidade é um **contador de capacidade**, não casamento de recursos.

```
livre(T, duração) = capacidade(T) − agendamentos(T) − holds_ativos(T) > 0
capacidade(T)     = override(T) ?? regra_padrão(T)   // limitada ao nº de cadeiras
```

- `regra_padrão`: escala normal (ex.: seg-sex 09–18, capacidade 2).
- `override`: ajuste do dia (faltou alguém → 1; reforço → 3). **Obrigatório no MVP.**
- No demo inicial, capacidade pode ser hardcoded. Config vem depois.

## Modelo de dados (Key Entities)

```
capacity_rule      weekday, start_time, end_time, capacity
capacity_override  date, start_time, end_time, capacity
booking            id, patient_name, patient_phone, appointment_type,
                   start, end, status (held|confirmed|patient_confirmed|cancelled|done),
                   expires_at (TTL p/ held), google_event_id,
                   attended_by (nullable), created_via (ai|human), created_at, updated_at
audit_log          id, entity, entity_id, action, actor, payload, created_at  (append-only)
```

Fonte de verdade: Google Calendar = eventos confirmados; Postgres = capacidade + holds + sync. Ingerir o Calendar via watch API / sync tokens para conhecer marcações feitas na mão.

## Contratos das ferramentas

Camada determinística. A LLM **nunca** escreve direto — só chama estas funções. Construir e testar isoladamente, sem LLM. Formato: API + Garantias + Testes obrigatórios (escritos ANTES da implementação).

### `get_availability(periodo, appointment_type) -> Slot[]`
- **Garantias**: única fonte de horário; só devolve slots que respeitam capacidade, horário de funcionamento e duração do tipo; determinística para o mesmo estado.
- **Testes**: retorna vazio quando capacidade esgotada; respeita `capacity_override`; nunca devolve slot fora do horário de funcionamento.

### `hold_slot(slot) -> Hold`
- **Garantias**: reserva **atômica** com TTL (advisory lock no horário → recheck `usado < capacidade` → inserir); idempotente; expira sozinha.
- **Testes**: **N holds concorrentes no mesmo horário nunca excedem a capacidade** (teste de concorrência obrigatório); hold expirado libera a vaga; segundo hold do mesmo paciente não duplica.

### `confirm_booking(hold_id, patient) -> Booking`
- **Garantias**: idempotente; grava no Calendar via `CalendarPort`; dispara confirmação via `MessagingPort`; registra em `audit_log`.
- **Testes**: confirmar hold válido grava exatamente um evento; confirmar hold expirado falha com erro tratável; chamada repetida não duplica.

### `reschedule_booking(booking_id, new_slot) -> Booking` / `cancel_booking(booking_id) -> void`
- **Garantias**: liberam a capacidade do horário antigo de forma atômica; auditadas.
- **Testes**: remarcar move sem deixar o horário antigo ocupado; cancelar devolve a capacidade.

### `escalate_to_human(reason, context) -> void`
- **Garantias**: notifica a recepção; encerra a tentativa autônoma; auditada.

## Loop de confirmação / lembrete (saída)

Job roda 24–48h antes. Para cada `confirmed`: envia pedido de confirmação. `SIM` → `patient_confirmed`. Remarcar/Não → libera capacidade + fluxo de remarcação. Sem resposta → política definida com a clínica.

## Guardrails (inegociáveis)

LLM nunca grava direto; `get_availability` única fonte de horário; confirmação explícita antes do commit; em qualquer dúvida → escalar; tudo em `audit_log`; botão de pânico / visão da clínica para sobrescrever.

## LGPD (dado de saúde = sensível)

Opt-in claro, opt-out fácil, coleta mínima, `audit_log` de toda operação, sem marketing sem consentimento.

## Camada WhatsApp (adapter)

Porta `MessagingPort` (`sendMessage`, `onMessage`) com duas implementações: **Evolution API** (dev/demo) e **Cloud API oficial** (piloto com pacientes reais). Construir contra a interface.

## Stack

TS/Node; PostgreSQL; Vitest; Claude via API com tool use (orquestrador, entra só na etapa da LLM); fila/cron para o lembrete; Google Calendar API + watch API.

## Ordem de construção (fatias verticais)

1. Camada determinística + testes (**sem LLM**, integrações stubbed). Garantir não-overbooking.
2. Fatia 1 (demo): agendar rotina → gravar no Calendar → confirmar no WhatsApp, com escalação como rede. Capacidade hardcoded.
3. Escalação robusta + FAQ.
4. Remarcar / cancelar.
5. Loop de lembrete + dashboard de ROI.
6. Config de capacidade + sync bidirecional do Calendar.

## Critérios de aceite do piloto

Taxa de falta antes vs. depois (meta conservadora ~1/3 de redução); nº de agendamentos 100% pela IA; nº de capturas fora do horário; tempo médio de resposta; nº de escalações e motivos.