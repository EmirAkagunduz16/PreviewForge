---
id: RPT-2026-09-17-m7-pr-close
type: session
status: verified
date: 2026-09-17
vault_sync: not-yet-synced
---

# M7 PR-CLOSE — 2026-09-17

## Result

M7-PR-CLOSE is verified complete. Pull-request-close commands now pass through a
durable PostgreSQL/Kafka cleanup path and the existing ownership-safe Kubernetes
delete seam. The active backlog advances to M7-TTL; the broader M7 integrated
acceptance remains gated on TTL and orphan cleanup.

## Implementation evidence

- `EnvironmentDeletionRepository` locks the environment deletion request,
  validates the event aggregate against PostgreSQL, serializes reopen/close
  races, holds the durable decision across the ownership-safe delete callback,
  and persists `COMPLETED`, `CANCELLED`, or bounded retryable/permanent failure.
- The close consumer claims Kafka delivery state durably, marks successful
  processing before committing the Kafka offset, retries retryable Kubernetes
  failures, and dead-letters ownership conflicts and invalid events without
  exposing payloads or raw errors.
- Reopening a closed pull request with the same SHA cancels actionable close
  requests and creates a fresh deployment intent; the webhook repository now
  treats only an actually closed pull request as eligible for close cleanup.
- Kubernetes deletion checks the exact PreviewForge environment ownership and
  uses UID/resourceVersion preconditions before deleting the namespace.

## Runtime acceptance

The following command passed against the local PostgreSQL service, Kafka broker,
and `kind-previewforge` cluster:

```text
DATABASE_URL=postgresql://previewforge:previewforge@localhost:55432/previewforge?schema=public KAFKA_BROKERS=localhost:59092 pnpm --filter @previewforge/worker exec vitest run src/cleanup/environment-deletion.acceptance.test.ts --no-file-parallelism
```

Result: 1 test file / 2 tests passed.

- An owned namespace was consumed from Kafka and deleted once; repeated close
  delivery settled as a durable no-op and the request remained `COMPLETED`.
- A wrong-owner namespace was not deleted; the request became `FAILED` with a
  safe ownership reason and the Kafka delivery was dead-lettered.
- The acceptance teardown removes all delivery rows for its disposable consumer
  groups, which keeps the from-beginning Kafka observation deterministic without
  leaving historical test messages in PostgreSQL.

## Repository verification and residue

- `pnpm check` passed: Biome checked 191 files; documentation checks verified
  215 local links across 60 files and consistency for 8 roadmap milestones,
  7 plans, and 4 active backlog entries; Turbo passed 18/18; database
  integration passed 14 files / 96 tests; API integration passed 5 files / 6
  tests; worker unit passed 23 files / 197 tests; worker M3 Kafka/PostgreSQL
  integration passed 1 file / 5 tests; all typechecks and builds passed.
- The targeted environment-deletion PostgreSQL suite passed 5/5 tests, and the
  webhook repository suite passed 8/8 tests.
- Final residue checks reported zero M7 acceptance users, projects, deletion
  requests, and `m7-close-consumer-*` Kafka delivery rows. The kind cluster had
  no `m7-*` or PreviewForge-managed acceptance namespace, and no acceptance
  process remained.

## Known limits

M7-TTL, M7-ORPHAN, and the complete M7 lifecycle acceptance are still pending.
The local kind cluster and Compose services are disposable runtime evidence, not
production RBAC/CNI or cloud-isolation evidence. During one repository-wide
verification attempt, an existing timestamp-plus-random integration fixture
collided on a unique installation ID; the isolated database suite and the final
`pnpm check` both passed, so this remains a pre-existing test-fixture flake
outside the M7 change scope.

## Links

- [M7 execution contract](../plans/m7-github-feedback-cleanup.md#M7-PR-CLOSE)
- [Active backlog](../backlog/active.md)
- [Completed backlog](../backlog/archive.md)
