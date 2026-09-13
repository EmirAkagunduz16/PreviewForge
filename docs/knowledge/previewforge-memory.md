---
title: PreviewForge project memory
status: active
updated: 2026-09-13
tags:
  - project/previewforge
  - architecture/control-plane
  - delivery/m3
---

# PreviewForge project memory

This is the project-local canonical index for durable decisions and context. Temporary implementation details and secrets do not belong here. The mirrored VictusOS note is [Projects/PreviewForge](../../../../Documents/VictusOS/🏰%20300-Projects/PreviewForge.md).

## Product boundary

PreviewForge turns a GitHub pull request into one isolated, short-lived Kubernetes preview: build the repository's single Dockerfile, publish an immutable image digest, reconcile a namespace-scoped HTTP workload, expose it through a platform Gateway, and report the result back to GitHub. The v1 boundary is GitHub-only, Dockerfile-only, one HTTP container per PR, one pre-provisioned cluster, and no arbitrary manifests or production deployments.

See [MVP scope](../product/mvp-scope.md) and [foundation research](../research/2026-09-12-foundation.md).

## Current verified direction

- M0 foundation is recorded complete: scope, threat model, ADRs, monorepo shape, local dependencies, quality gates, and domain contract tests are in place.
- M1 is complete. Its database, configuration, observability, API-error, compare-and-set transition, transactional outbox, and PostgreSQL integration-test slices are verified and archived.
- M2 is complete. GitHub App OAuth/session handling, verified installation ownership, authorized repository import, raw-byte webhook verification, durable delivery deduplication, source ordering, deployment intent, and close deletion intent are integrated and independently tested.
- PostgreSQL is authoritative. Kafka is an at-least-once transport behind a transactional outbox; Redis is deliberately deferred until a measured need exists.
- The API remains one modular NestJS application and the worker remains independently scalable; a new network service requires an ADR.

See [system design](../architecture/system-design.md), [delivery roadmap](../delivery/roadmap.md), and [ADR 0002](../architecture/decisions/0002-postgres-outbox-and-kafka.md).
Verified session findings and incidents are indexed under [project reports](../reports/index.md).

## Non-negotiable invariants

1. Verify GitHub webhook HMAC over raw request bytes and deduplicate by the delivery ID.
2. Treat external webhooks, outbox publication, and Kafka consumption as at-least-once; use durable idempotency keys and atomic guards.
3. A deployment may perform external side effects or publish readiness only while its commit SHA equals the environment's desired SHA.
4. Persist each state transition and outbox event atomically; terminal deployments cannot be rewound.
5. Never pass platform, GitHub, registry, database, or Kubernetes credentials into a user build; never log secret values.
6. Preview resources require ownership/expiry metadata, resource requests and limits, restricted security posture, default-deny network policy, and disabled service-account token automounting.
7. Deploy image digests, never mutable tags; cleanup and reconciliation must be safe to repeat.

See [deployment state machine](../architecture/deployment-state-machine.md), [threat model](../security/threat-model.md), and the [control-plane skill](../../.agents/skills/previewforge-control-plane/SKILL.md).

## Decision map

- [ADR 0001 — modular control plane](../architecture/decisions/0001-modular-control-plane.md)
- [ADR 0002 — PostgreSQL, outbox, and Kafka](../architecture/decisions/0002-postgres-outbox-and-kafka.md)
- [ADR 0003 — Gateway API](../architecture/decisions/0003-gateway-api.md)
- [ADR 0004 — rootless BuildKit](../architecture/decisions/0004-rootless-buildkit.md)
- [ADR 0005 — SSE live output](../architecture/decisions/0005-sse-for-live-output.md)

## Next handoff

Plan M3 Kafka dispatch and worker claims from the delivery roadmap. Add stable M3 slices to the active backlog before implementation, preserve the PostgreSQL outbox as the source of truth, and prove at-least-once delivery, leases, receipts, retries, and desired-SHA guards with real Kafka/PostgreSQL acceptance tests. Update this note only for durable decisions, verified milestones, or security-relevant lessons, then mirror the durable summary to the linked VictusOS note.
