# M8 local observability

The Compose `observability` profile provides disposable Prometheus, Grafana,
OpenTelemetry Collector, and Tempo processes. It does not own PreviewForge
state and it must not be used as a production deployment.

Start it with:

```bash
node scripts/local-infra.mjs --profile observability up -d --wait
```

The API exposes `/metrics` and `/traces`; the worker exposes the same paths on
`PREVIEWFORGE_WORKER_OBSERVABILITY_PORT` (default `9465`). Set
`PREVIEWFORGE_WORKER_OBSERVABILITY_HOST=127.0.0.1` and
`PREVIEWFORGE_OTEL_EXPORTER_ENDPOINT=http://127.0.0.1:14318` when the local
collector is running. Grafana is available at `http://127.0.0.1:53000` and
Prometheus at `http://127.0.0.1:59090`.

All metric labels and trace attributes are bounded by the shared observability
package. Commit SHAs, repository names, environment/deployment IDs, payloads,
tokens, and environment values are deliberately excluded.
