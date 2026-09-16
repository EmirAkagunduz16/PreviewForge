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

## M7 — GitHub feedback and cleanup (active) — week 7

- Create/update GitHub check runs with preview URL and failure summary.
- Delete on PR close, implement TTL policy, and add an orphan reconciler.
- Acceptance: deletion is idempotent and reconciliation removes a labeled orphan with missing database state according to policy.

## M8 — Hardening and cloud demo (week 8)

- Add end-to-end tests, failure injection, metrics/traces, operational dashboards, backup/restore notes, and demo fixtures.
- Deploy to one AWS EKS/ECR environment only after local acceptance criteria pass.
- Acceptance: recorded demo covers open, synchronize race, failure, retry, ready, and close cleanup.

## Deferred backlog

- Redis for measured cache/rate-limit needs
- Strong hostile-tenant sandboxing
- Multiple containers and persistent storage
- GitLab/Bitbucket
- Production deployments and custom domains
