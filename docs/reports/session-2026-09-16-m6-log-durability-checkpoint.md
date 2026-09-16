---
id: RPT-2026-09-16-m6-log-durability-checkpoint
type: session
status: partial
date: 2026-09-16
vault_sync: synced
---

# M6 LOG-DURABILITY implementation checkpoint

## State

M6-LOG-DURABILITY resumed from the interrupted WIP checkpoint `f7b419d`. The migration,
transactional database repository, BuildKit streaming/persistence seam, and focused tests
are now implemented in the working tree. This slice remains **in progress**, not accepted
or complete, because the real BuildKit/registry integration fixture has not run.

The migration was applied successfully to the disposable PostgreSQL database
`previewforge_m5_20260915`. `LogChunk.createdAt` uses Prisma's PostgreSQL-compatible
`TIMESTAMP(3)` mapping; `Deployment.logSequenceHighWatermark` means the next deployment-
local sequence to allocate, starts at 1, and is backfilled from `MAX(sequence) + 1`.

The repository serializes appends against deployment/environment state, rejects stale
desired SHAs, chunks UTF-8 only at code-point boundaries (16,384 bytes maximum), retains
at most 2,097,152 text bytes per deployment, expires rows by `createdAt` after 30 days,
and keeps sequence progress after eviction. BuildKit stdout/stderr are persisted through
an asynchronous backpressure callback; the buildctl child has a credential-limited
environment and persistence failures are surfaced as redacted infrastructure errors.

## Verification evidence

- `prisma migrate deploy` against disposable PostgreSQL: passed; migration applied.
- `packages/database/test/log-chunk-repository.integration.test.ts`: **6/6 passed** on
  PostgreSQL, including UTF-8 boundaries, repository restart/read, byte-cap eviction,
  age expiry, concurrent sequence allocation, rollback, stale writer, and exhaustion.
- `pnpm check`: passed. This includes Biome and docs checks; typecheck/test/build across
  all six packages; database integration **87/87**, API integration **3/3**, and worker
  M3 integration **5/5**. Worker unit tests passed **170/170**.
- BuildKit adapter unit tests passed **12/12**, including real spawned stdout/stderr,
  credential environment exclusion, callback backpressure, persistence failure
  redaction, and SIGKILL escalation after a child ignores SIGTERM.
- `git diff --check`: passed.
- Real BuildKit/registry integration: **not run**. The local compose stack contains no
  BuildKit service, and `buildctl` is absent. The real rootless BuildKit fixture is
  specified by the M4 hosted-runner workflow; do not substitute a mocked adapter or a
  privileged local daemon and do not claim this acceptance passed.

This remains a partial WIP and is not accepted or complete. The code has been reviewed
independently; the SIGTERM/SIGKILL timeout defect found during review was corrected and
retested.

## Next action and unrelated prerequisite

Run the real rootless BuildKit/registry log fixture using the canonical M4 hosted-runner
environment. It must build/push the fixture, persist actual output, and read that output
from a fresh `LogChunkRepository` instance before this slice can be accepted. If that
runner cannot be used, keep the slice partial and record the exact blocker.

`OPS-M5-HEALTH-ACCEPTANCE-DRIFT` remains open and must be resolved before integrated M6
acceptance. It does not block this isolated log-durability runtime fixture.

## Links

- [M6 plan](../plans/m6-dashboard-live-logs.md#M6-LOG-DURABILITY)
- [Active backlog](../backlog/active.md)
- [Locked product contract](decision-2026-09-16-m6-product-contract.md)
