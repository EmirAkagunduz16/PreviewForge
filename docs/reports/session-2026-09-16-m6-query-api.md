---
id: RPT-2026-09-16-m6-query-api
type: session
status: verified
date: 2026-09-16
vault_sync: synced
---

# M6 Query API slice complete

## Context

Closed only `M6-QUERY-API`: authenticated owner-scoped project, active-preview,
deployment-history, and deployment-detail reads. M6 dashboard/live logs remains active;
environment management, durable logs, SSE, dashboard UI, and integrated M6 acceptance
remain unfinished.

## Verified finding

The database repository uses explicit Prisma projections and owner predicates, bounded
cursor pagination ordered by creation timestamp plus ID, and the current desired SHA
to join each preview to its current deployment. The HTTP API preserves the existing
session cookie and error envelope, returns only caller-owned rows, and makes valid but
absent and non-owned IDs indistinguishable. Fixture credentials, session data, owner
internals, and worker lease fields are not serialized.

Root's second review found two evidence gaps before closure: the test's expected PR
title did not match its seeded fixture, and the slice lacked a real HTTP route test.
The oracle was corrected to the seeded `PR 42`, and a focused HTTP/PostgreSQL test was
added and passed. No implementation behavior was relaxed.

## Evidence

- `pnpm --filter @previewforge/database exec vitest run test/dashboard-repository.integration.test.ts --no-file-parallelism` — 1/1 passed against disposable PostgreSQL.
- `pnpm --filter @previewforge/api test:integration` — 2/2 passed, including the new HTTP/PostgreSQL dashboard test.
- `pnpm --filter @previewforge/api test` — 53/53 unit tests passed.
- `DATABASE_URL=<disposable PostgreSQL URL> KAFKA_BROKERS=<local Kafka bootstrap> pnpm check` — exit 0. Documentation checks verified 153 local links across 51 files and consistency for 7 roadmap milestones, 6 plans, and 6 active entries; Turborepo passed 15/15; database integration 80/80; API integration 2/2; worker integration 5/5; worker unit 159/159.
- Post-run database residue check: users/projects/deployments = 0/0/0.
- Review: root's second pass repaired the fixture-oracle mismatch and missing HTTP acceptance coverage; both corrected tests passed in the evidence above.
- Implementation commit: `12a89d73a0a7dca554316245f2e17429517c6163`.
- Push: not-run; project protocol requires explicit user authorization.

## Impact / consequences

The next dependent dashboard slice can rely on authenticated, owner-scoped project and
deployment query projections. This closes no other M6 backlog item and does not imply
that live logs, environment-variable management, or the dashboard UI are delivered.

## Prevention / next action

The `M6-PRODUCT-CONTRACT` gate was approved and archived on 2026-09-16; see the
[canonical decision report](decision-2026-09-16-m6-product-contract.md) for exact
project-scoped variable and log-byte/retention/gap semantics. Proceed sequentially with
M6-ENV-VARS, then M6-LOG-DURABILITY, SSE, dashboard, and integrated acceptance. Those
implementation slices remain unfinished. M7 cleanup orchestration and M8 production
RBAC/CNI concerns remain deferred as already scoped.

## Related links

- [M6 execution plan](../plans/m6-dashboard-live-logs.md)
- [Active backlog](../backlog/active.md)
- [Archived backlog](../backlog/archive.md)
- [Database dashboard repository](../../packages/database/src/dashboard-repository.ts)
- [Dashboard HTTP integration test](../../apps/api/src/dashboard.integration.test.ts)
- [VictusOS session distillation](../../../../Documents/VictusOS/Reports/PreviewForge/2026-09-16%20M6%20Query%20API.md)
