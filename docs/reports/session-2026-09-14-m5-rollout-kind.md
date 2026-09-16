# M5-ROLLOUT real kind verification — 2026-09-14

## Scope

Verify rollout availability, HTTP health-check gating, durable failure outcomes, and supersession against a real disposable kind workload.

## Environment repair

- Docker CLI context was changed from the stale `desktop-linux` socket to `default` (`unix:///var/run/docker.sock`).
- Disposable `previewforge` kind cluster was recreated with the repository bootstrap script.
- The immutable `nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10` image was imported directly into the kind node containerd store after `kind load docker-image` hit a checkpoint-image error.
- The non-root fixture listened on 8080 and was reached through `kubectl port-forward service/preview 18080:80`.

## Evidence

| Scenario | Real observation | Rollout result |
| --- | --- | --- |
| Available + HTTP health | Deployment `1/1` Available; `curl http://127.0.0.1:18080/` returned 200 | `READY`; only `WAITING_FOR_HEALTHCHECK -> READY` was recorded |
| HTTP health failure | `curl http://127.0.0.1:18080/not-found` returned 404 | `FAILED`; stage `HEALTHCHECK`, code `HEALTHCHECK_FAILED`; no READY transition |
| Rollout failure | Real Kubernetes API was polled for a missing Deployment until deadline | `FAILED`; stage `ROLLOUT`, code `ROLLOUT_TIMEOUT`, retryable `true` |
| Supersession | Real available Deployment was observed, then desired-SHA guard returned false | `SUPERSEDED`; only stale supersession transition was recorded; no READY transition |

The Kubernetes API client used the active kind context, and the HTTP check used the live port-forwarded workload. Transition persistence was represented by the deployment-store boundary in the acceptance harness; repository transition behavior is covered by the existing database/integration checks.

## Remaining risk

`Gateway/previewforge` remains `Programmed=False` because kind does not allocate a LoadBalancer address. This is intentionally deferred to `M5-ACCEPTANCE`, which will use NodePort or port-forward routing access.

## Verification

- `pnpm --filter @previewforge/worker test:unit -- src/kubernetes` — 116/116 passed.
- `pnpm --filter @previewforge/worker typecheck` — passed.
- Full `pnpm check` — passed with local PostgreSQL/Kafka: Biome, docs checks, 15/15 Turbo tasks, database integration 79/79, API integration 1/1, and worker M3 integration 5/5.
