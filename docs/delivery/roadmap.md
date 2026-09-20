# Delivery roadmap

The plan is milestone-based so each slice has observable acceptance criteria. Calendar estimates assume one primary developer using coding agents and should be revised from measured throughput.

## M0 — Foundation (complete)

- Research and record current platform choices.
- Establish scope, threat model, ADRs, monorepo, quality gates, local dependencies, and domain contract tests.
- Acceptance: `pnpm check` passes and local dependencies become healthy.

## M1 — Durable control-plane core (complete)

- Add PostgreSQL schema and migrations for user, installation, project, pull request, environment, deployment, webhook delivery, outbox, consumer receipt, and log chunk.
- Add configuration validation, structured logging, request IDs, and API error envelope.
- Implement compare-and-set deployment transitions and transactional outbox writes.
- Acceptance: integration tests prove duplicate intent is harmless and terminal states cannot be rewound.

## M2 — GitHub App vertical slice (complete)

- Add GitHub sign-in and installation callback.
- List accessible repositories and import a Dockerfile project.
- Verify raw webhook signatures and dedupe delivery IDs.
- Handle `opened`, `reopened`, `synchronize`, and `closed`.
- Acceptance: fixture webhooks create exactly one desired deployment and close creates a deletion request.

## M3 — Kafka dispatch and worker claims (complete)

- Implement outbox relay and versioned Kafka producers/consumers.
- Add deployment leases, event receipts, retry classification, and dead-letter visibility.
- Add desired-SHA guards and supersession tests.
- Acceptance: broker or worker restarts do not lose intent or cause duplicate state transitions.

## M4 — Rootless image build (complete)

- Acquire source using a short-lived installation token outside the build trust zone.
- Build with rootless BuildKit, stream redacted progress, enforce time/resource limits, and push to the local registry.
- Resolve and persist immutable image digest.
- Acceptance: a sample public and private repository build; credentials are absent from context, layers, and logs.

## M5 — Kubernetes preview reconciliation (complete)

- Create kind cluster bootstrap and a conformant Gateway controller.
- Reconcile namespace policy, Deployment, Service, Secret, and HTTPRoute.
- Implement rollout and configurable HTTP health checking.
- Acceptance: complete. On 2026-09-16, real kind acceptance passed 3/3 against disposable PostgreSQL, kind, registry, and Envoy Gateway; see the [session evidence](../reports/session-2026-09-15-m5-kind-acceptance.md).

## M6 — Dashboard and live logs (complete) — week 6

- Implement project list, active previews, deployment detail, pipeline stages, history, and SSE logs with resume cursor.
- Add write-only environment-variable management.
- Acceptance: complete. Dedicated PostgreSQL/Kafka/BuildKit/registry/kind/Gateway/browser
  acceptance passed with owner isolation, durable logs/cursor replay, write-only encrypted
  environment values, redacted failure, and zero fixture/namespace residue; see the
  [integrated evidence report](../reports/session-2026-09-16-m6-acceptance-progress.md).

## M7 — GitHub feedback and cleanup (complete) — week 7

- Create/update GitHub check runs with preview URL and failure summary.
- Delete on PR close, implement TTL policy, and add an orphan reconciler.
- Acceptance: complete. Real PostgreSQL/Kafka/kind/Envoy acceptance verified repeated close, TTL expiry, DB-missing orphan cleanup, stale-SHA supersession, wrong-owner safety, and zero disposable residue; see the [M7 integrated acceptance report](../reports/session-2026-09-17-m7-acceptance.md).

## M8 — Local hardening (complete) — week 8

- Add end-to-end tests, failure injection, metrics/traces, operational dashboards, backup/restore notes, and demo fixtures.
- Acceptance: complete. The 2026-09-18 local gate passed with a real rootless BuildKit v0.33.0 worker/socket, API and worker failure matrices, restore/outbox replay, telemetry and dashboards, real kind/Envoy acceptance, repository-wide checks, and zero disposable residue; see the [M8 local gate report](../reports/session-2026-09-18-m8-local-gate.md).
- The AWS EKS/ECR demo is explicitly deferred to the blocked M10 cloud track; it is not an M8 dependency or acceptance claim.

## M9 — Local product experience (active)

- Provide one observable, ownership-safe command path to start, inspect, and stop the complete local runtime.
- Complete GitHub App installation discovery, repository selection, project import, and actionable empty/error states in the dashboard.
- Emit directly clickable local preview URLs through the real kind/Envoy Gateway topology.
- Prove the browser journey against controlled GitHub fixtures and real disposable PostgreSQL, Kafka, rootless BuildKit, registry, kind, and Envoy dependencies.
- Acceptance: `pnpm local:up` reaches ready without hidden manual steps; a user completes sign-in/install/import/open/synchronize/failure/retry/READY/log/preview/close from the browser; direct acceptance, repository checks, fault sensitivity, cleanup, and residue inspection pass. See the [M9 execution plan](../plans/m9-local-product-experience.md).

## M10 — AWS EKS/ECR cloud demo (deferred / blocked)

- Status: blocked until an explicit maximum spend, billing alert, disposable account and region, and destroy procedure are approved.
- No AWS credential, account, preflight, or resource mutation is part of the current local delivery state.
- Acceptance remains future work: the fixture must reach EKS READY through an immutable ECR digest, negative RBAC and network-policy probes must pass, and close cleanup must leave no cloud demo residue.

## Deferred backlog

- Redis for measured cache/rate-limit needs
- Strong hostile-tenant sandboxing
- Multiple containers and persistent storage
- GitLab/Bitbucket
- Production deployments and custom domains
