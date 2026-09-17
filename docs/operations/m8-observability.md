# M8 observability runbook

M8 observability is local and disposable. The API and worker produce bounded
Prometheus metrics and W3C trace context without sending product payloads or
credentials to the telemetry layer.

## Endpoints

- API: `GET /metrics` and `GET /traces` on the API listener.
- Worker: `GET /metrics` and `GET /traces` on
  `PREVIEWFORGE_WORKER_OBSERVABILITY_PORT` (default `9465`).
- Prometheus: `http://127.0.0.1:59090`.
- Grafana: `http://127.0.0.1:53000`, dashboard `PreviewForge M8 local hardening`.
- OpenTelemetry Collector: OTLP/HTTP at `http://127.0.0.1:14318`.
- Tempo: `http://127.0.0.1:53200`.

Start the disposable telemetry profile beside the normal local services:

```bash
pnpm infra:up
node scripts/local-infra.mjs --profile observability up -d --wait
```

Start the API and worker with:

```bash
PREVIEWFORGE_OTEL_EXPORTER_ENDPOINT=http://127.0.0.1:14318 \
PREVIEWFORGE_WORKER_OBSERVABILITY_HOST=127.0.0.1 \
PREVIEWFORGE_WORKER_OBSERVABILITY_PORT=9465 \
  <normal local API/worker start command>
```

The local acceptance runner performs a health request, scrapes both metric
endpoints, checks that the dashboards are provisioned, and queries both trace
snapshots. A successful HTTP span and its Kafka child must share the same
`traceId`; the child carries the HTTP span ID as its parent. Missing endpoints,
zero discovered dashboard panels, or unlinked spans fail the gate.

The acceptance runner binds its disposable API and worker telemetry listeners to
`0.0.0.0` only because Prometheus runs in a separate local Docker network and
scrapes through `host.docker.internal`. Normal local starts remain loopback-
bound; do not publish these listeners outside the local machine.

## Safety contract

Allowed metric labels are limited to route/method/status, stage/outcome,
retry class, topic, consumer, and error code. Trace attributes are limited to
HTTP, messaging, stage/outcome, error, and service metadata. Commit SHAs,
repository names, environment/deployment IDs, raw bodies, tokens, and
environment-variable values remain outside metrics, traces, and logs.

The trace endpoint emits an OTLP-compatible JSON resource/span envelope for
the disposable local oracle. The Collector and Tempo profile provides the
normal backend path, but neither component becomes a PreviewForge state store.
