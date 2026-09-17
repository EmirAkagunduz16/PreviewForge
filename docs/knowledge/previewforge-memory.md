---
title: PreviewForge project memory
status: active
updated: 2026-09-17
tags:
  - project/previewforge
  - architecture/control-plane
  - delivery/m8
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
- M3 is complete and archived. Durable Kafka contracts, PostgreSQL relay/claim state, bounded retries, receipts, desired-SHA fencing, real broker restart acceptance, and worker shutdown are verified; the local one-broker/no-volume limitation remains.
- M4 is complete. Source acquisition, the rootless BuildKit adapter, desired-SHA-guarded digest persistence, hosted-runner provisioning, checksum-pinned binaries, and the real build/push/digest harness are implemented. Hosted runs `34860645607`, `34864066506`, and `34864803550` proved the RootlessKit path, private/public fixtures, source failure, BuildKit timeout classification, credential-free build boundary, digest persistence, stale-SHA supersession, and cleanup. Duplicate delivery and retry idempotency are covered by the completed M3 real Kafka/PostgreSQL acceptance.
- M5 is complete. Real kind acceptance on 2026-09-16 passed 3/3 against disposable PostgreSQL, registry, kind, and Envoy Gateway; it verified digest-backed routed readiness, failure/supersession outcomes, Secret removal, ownership-safe deletion, and cleanup. See the [canonical M5 session report](../reports/session-2026-09-15-m5-kind-acceptance.md); production worker RBAC and production CNI enforcement remain deferred cloud-demo risks.
- M6 is complete. Dedicated `previewforge_m6_20260916` acceptance passed API 5 files/6 tests, real rootless BuildKit durable logs 1/1, real kind/Envoy Gateway 1 file/3 tests, and browser owner/history/log refresh/write-only/sign-out checks; final PostgreSQL fixture, managed namespace, BuildKit runtime, and process residue were zero. See the [canonical M6 acceptance report](../reports/session-2026-09-16-m6-acceptance-progress.md), the [M6 Dashboard report](../reports/session-2026-09-16-m6-dashboard.md), and [active backlog](../backlog/active.md).
- M7 is complete. `M7-CHECKS`, `M7-PR-CLOSE`, `M7-TTL`, and `M7-ORPHAN` are implemented and the consolidated real acceptance verified repeated close, TTL expiry, DB-missing orphan cleanup, stale-SHA supersession, Envoy Gateway routing, wrong-owner safety, and zero M7 residue. See the [M7 integrated acceptance report](../reports/session-2026-09-17-m7-acceptance.md), the [PR-CLOSE report](../reports/session-2026-09-17-m7-pr-close.md), and the [TTL/orphan report](../reports/session-2026-09-17-m7-ttl-orphan.md).
- M8 planning is complete for local hardening: deterministic fixtures, failure-injected local E2E, metrics/traces, dashboards, backup/restore notes, and local acceptance are active; AWS EKS/ECR is explicitly deferred as blocked M9 work until an approved cost boundary exists. See the [M8 execution plan](../plans/m8-hardening-cloud-demo.md) and [active backlog](../backlog/active.md).
- The canonical M4 topology keeps rootless BuildKit and a plain-HTTP registry in one RootlessKit `slirp4netns` namespace, keeps `--disable-host-loopback`, exposes only registry loopback `127.0.0.1:5000`, and reaches BuildKit through a Unix socket. No Docker socket, privileged mode, `apparmor=unconfined` container/runtime flag, BuildKit TCP listener, or global AppArmor/sysctl weakening is accepted. Ubuntu's named per-binary unconfined RootlessKit profile is distinct from those forbidden global/runtime relaxations.
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

## How to resume

Use [the roadmap](../delivery/roadmap.md) for milestone status and [the active backlog](../backlog/active.md) for the next unfinished action. M3 through M7 are complete; M8 local hardening is active and the M9 cloud demo is deferred. Read this file when a durable invariant or decision is needed; it is an index, not a progress log. Update it only for durable decisions, verified milestones, or security-relevant lessons, then mirror the durable summary to the linked VictusOS note.
