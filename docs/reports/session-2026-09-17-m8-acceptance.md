---
id: RPT-2026-09-17-m8-acceptance
type: session
status: verified
date: 2026-09-17
vault_sync: pending
---

# M8 local hardening acceptance

## Result

M8 implementation is integrated for the local hardening slices: deterministic
fixtures and restore guidance, failure-injected API/worker E2E coverage,
metrics and traces, provisioned local dashboards, and the disposable local
acceptance runner. The available local runtime boundaries passed. M8 remains
active only because the host does not currently provide `buildkitd`,
`buildctl`, or a BuildKit socket, so the rootless BuildKit portion of the
integrated local acceptance gate is not claimed.

The AWS/EKS/ECR track remains explicitly deferred as blocked M9 work. No AWS
credential, account, EKS cluster, ECR repository, or cloud resource was
requested, inspected, created, or mutated during this work.

## Runtime identity

The acceptance runner enforced and recorded the following disposable local
targets:

- Docker context: `default`.
- Kubernetes context: `kind-previewforge`; the `previewforge` node was Ready
  on Kubernetes `v1.37.0`.
- PostgreSQL: local Compose service on `127.0.0.1:55432`, PostgreSQL 18.1.
- Kafka: local Compose broker on `127.0.0.1:59092`, Kafka 4.3.1.
- Registry: local Compose registry on `127.0.0.1:55000`.
- Gateway: local Envoy Gateway through the disposable loopback port-forward
  at `127.0.0.1:18080`.
- Telemetry profile: Prometheus `v3.5.0` on `59090`, Grafana `12.1.1` on
  `53000`, Tempo `2.8.2` on `53200`, and the OpenTelemetry Collector
  `0.136.0` on `14318`.

The local M5 fixture used the immutable registry digest
`sha256:4517e9228acbf16f2393f7a3f710be0a0fe056d0c06d382ef557d50dc2abc075`.

## Acceptance evidence

| Boundary | Observed evidence | Result |
|---|---|---|
| Fixture/restore | Fixture manifest validation passed. The restore drill seeded 2 deployments and 2 webhook deliveries, repeated the seed without duplication, restored 2 deployments with 2 pending outbox rows, replayed/published 2/2 event identities, and reduced pending outbox from 2 to 0. Source/restore databases, dump directory, observer group, registry artifacts, and Kubernetes resources were removed or absent after teardown. | Passed |
| API failure matrix | `src/m8.integration.test.ts`: 1 file, 2 tests against local PostgreSQL and a real Nest HTTP server. Raw-body HMAC, duplicate/reordered delivery, transaction rollback before outbox commit, redaction, and related durable failure behavior were exercised. | Passed |
| Worker failure matrix | `src/m8.acceptance.test.ts`: 1 file, 6 tests against PostgreSQL 18.1, Kafka 4.3.1, and a real HTTP Check Run fixture. Covered offset redelivery, stale-SHA supersession, durable retry, lost Check Run recovery, redaction, and interrupted cleanup. | Passed |
| Observability | API and worker metrics were scraped. The local Grafana M8 dashboard was provisioned; Prometheus returned real samples; Tempo became ready; and the injected trace `33333333333333333333333333333333` was observed on the Kafka `kafka.consume` child with the injected parent span `4444444444444444`. Credential-shaped values were rejected from telemetry output. | Passed |
| Real Kubernetes/Gateway boundary | M5 acceptance: 1 file, 3 tests against kind and Envoy Gateway. The immutable digest reached the routed preview path and cleanup/ownership checks passed. | Passed |
| Rootless BuildKit | `buildkitd`, `buildctl`, and the expected local BuildKit socket were absent. The acceptance runner therefore did not fabricate or skip this boundary silently. Existing hosted M4 evidence remains valid for M4 but is not relabeled as fresh local M8 evidence. | Open |

The acceptance runner was executed after the runtime implementation changes.
The final formatting pass changed only formatting; the subsequent repository
check passed on the final tree.

## Observability implementation

The local telemetry contract is implemented in `packages/observability/` and
is wired into the API and worker. It provides bounded labels for route family,
method, status, stage, outcome, retry class, topic, consumer, and error code.
Trace context is propagated through the PostgreSQL outbox and Kafka headers;
the database migration is `20260917150000_m8_trace_context`.

The disposable profile is provisioned under
`infrastructure/observability/` and is started through the local Compose
`observability` profile. The profile is local operator infrastructure only;
it does not become a PreviewForge state store or product service. Tempo uses
a local-only root user override to initialize its fresh named volume; that
identity is not inherited by PreviewForge workloads.

## Repository verification

The final repository verification command was:

```bash
env DATABASE_URL='postgresql://previewforge:previewforge@127.0.0.1:55432/previewforge?schema=public' \
  KAFKA_BROKERS='127.0.0.1:59092' \
  pnpm check
```

It passed with:

- Biome check successful (only non-fatal undeclared-environment warnings for
  the acceptance runner's explicit runtime knobs).
- `docs:check` successful: 261 local Markdown links and context consistency
  for 9 roadmap milestones, 8 plans, and 5 active backlog entries.
- Turbo verification successful across 21 tasks, including observability
  tests (3), contracts (24), database tests/build, API tests/build, worker
  tests/build, and the configured PostgreSQL/Kafka integration suites.
- `git diff --check` successful after the final documentation update.

## Residue and safety

The acceptance runner kills the API and worker process groups, deletes its
exact telemetry containers and named volumes, deletes its fixed trace-probe
rows, and removes the disposable restore databases and dump directory. The
base PostgreSQL/Kafka/registry services are pre-existing local infrastructure
and were not broadly destroyed. Historical non-M8 rows in the base database
were not treated as disposable fixture residue.

No credential value was added to fixtures, telemetry labels, traces, API
responses, logs, or build context. No privileged, unconfined, Docker-socket,
global AppArmor, or global sysctl shortcut was introduced.

## Changed files and commits

The implementation is recorded in commit `67b49ac` (`feat(m8): add local
observability and acceptance gate`). It includes the observability package,
API/worker instrumentation, trace propagation and migration, local telemetry
profile, M8 acceptance runner, and observability runbook.

The remaining project-canonical changes update the M8 plan, active/archive
backlog, roadmap, project memory, report index, and this report. M8-OBS is
archivable with the evidence above. M8-E2E-FAULTS, M8-LOCAL-ACCEPTANCE, and
M8-ACCEPTANCE remain `needs-review` until the local rootless BuildKit
prerequisite is restored and the gate is rerun. M9-CLOUD-DEMO remains
`blocked`; no cloud work is part of this report.

## Reproduction commands

```bash
node scripts/m8/fixtures/manifest.mjs --check
node scripts/m8/run-local-acceptance.mjs
pnpm check
pnpm docs:check
git diff --check
```

The acceptance runner refuses non-loopback PostgreSQL/Kafka targets, non-local
Docker context overrides, and non-kind Kubernetes contexts. It also binds
temporary API/worker listeners to `0.0.0.0` only so the local Dockerized
Prometheus can scrape them through `host.docker.internal`; normal local starts
remain loopback-bound.
