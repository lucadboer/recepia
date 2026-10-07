# Quickstart: Observability and Cost Control

## See one booking as a trace (local)
```bash
docker compose --profile observability up -d            # Postgres + Jaeger (UI http://localhost:16686, OTLP :4318)
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 pnpm perf:smoke --conversations 1
# Jaeger → service "recepia" → one trace per inbound message:
# webhook.inbound → agent.turn → chat claude-… / execute_tool hold_slot / pg.query … → outbox.dispatch (linked)
```

## Logs
```bash
LOG_LEVEL=debug pnpm evals:fake 2>&1 | head                 # JSON lines, trace_id/span_id, phones masked (***0101)
LOG_LEVEL=debug pnpm evals:fake 2>&1 | grep -E '\+55[0-9]{10,}' && echo LEAK || echo "no full phone in logs"
```
Set `TELEMETRY_HASH_KEY` (any long random string) so patient pseudonyms stay stable across restarts.

## Health
```bash
curl -s localhost:3000/healthz    # {"status":"ok"}
curl -s localhost:3000/readyz     # {"status":"ready"} or 503 {"status":"not_ready"} when Postgres is down
```

## Budget and caching
- `AGENT_BUDGET_USD` (default 0.25): reaching it hands the conversation to reception (`escalated`, reason `budget_exceeded`).
- One cheap live check (≈ US$ 0.02): `LIVE_LLM=1 pnpm test:live` — the round-trip test prints `cacheRead` > 0 on the second call.
- Live evaluation reports cache hit ratio and per-execution cost: `pnpm evals:live --repetitions 1 --cap-usd 1`.

## Fallback provider (optional, owner's choice)
```bash
FALLBACK_LLM_BASE_URL=https://<provider>/v1 FALLBACK_LLM_API_KEY=… FALLBACK_LLM_MODEL=<model> pnpm start
```
The model must have a price in `src/llm/pricing.json` or the service refuses to start.

## Retention (LGPD, 90 days)
```bash
pnpm retention:purge --dry-run     # counts only
pnpm retention:purge               # deletes, writes one retention_purged audit row
```
