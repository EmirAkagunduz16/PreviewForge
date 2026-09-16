---
id: RPT-2026-09-16-m6-log-durability-checkpoint
type: session
status: verified
date: 2026-09-16
vault_sync: synced
---

# M6 LOG-DURABILITY completion evidence

## State

M6-LOG-DURABILITY resumed from the interrupted WIP checkpoint `f7b419d` and is now
**complete**. The implementation/evidence commit is
`d6d3f9ff59d02bc5646a3d795dabbf72b95736c5` on `main`. Verification finished on
2026-09-16 at 15:25 UTC (18:25 Europe/Istanbul).

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
  PostgreSQL, including UTF-8 boundaries, ANSI CSI/OSC terminal-control stripping,
  repository restart/read, byte-cap eviction, `createdAt` age expiry, concurrent
  sequence allocation, rollback, stale-writer rejection, and sequence exhaustion.
- `pnpm check`: passed. This includes Biome and docs checks; typecheck/test/build across
  all six packages; database integration **87/87**, API integration **3/3**, and worker
  M3 integration **5/5**. Worker unit tests passed **170/170**.
- BuildKit adapter unit tests passed **12/12**, including real spawned stdout/stderr,
  credential environment exclusion, callback backpressure, persistence failure
  redaction, and SIGKILL escalation after a child ignores SIGTERM.
- `git diff --check`: passed.
- Real rootless BuildKit/registry: GitHub Actions [workflow run #14](https://github.com/EmirAkagunduz16/PreviewForge/actions/runs/35115043471)
  passed on `ubuntu-24.04` in **1m 44s**. The actual command
  `pnpm test:acceptance:build` ran `test:build:integration` **1/1** and M4 integration
  **5/5**. The BuildKit log fixture built and pushed a real image, persisted live
  stdout/stderr into the ephemeral PostgreSQL database, then read nonempty ordered chunks
  from a fresh `LogChunkRepository` instance; secret sentinel was absent. The workflow
  also verified rootless namespace/UID/GID maps, the BuildKit Unix socket, registry
  digest, and cleanup.
- Durability fault injection: a PostgreSQL trigger intentionally failed the high-water
  update after chunk insertion; the test proved both chunks and sequence state rolled
  back, then proved a subsequent append recovered at sequence 1.
- Runtime identity: local PostgreSQL verification used the disposable database
  `previewforge_m5_20260915`; the hosted workflow used its ephemeral local PostgreSQL,
  rootless BuildKit, and loopback registry. No production/shared target was used.
- The hosted run emitted one non-blocking GitHub Actions warning that checkout/setup
  actions currently target Node 20 and were forced to Node 24. It did not affect the
  successful build or acceptance.

The SIGTERM/SIGKILL timeout defect found during independent review was corrected and
retested before the hosted run. The exact implementation changed-file set is recorded in
`git show --stat d6d3f9ff59d02bc5646a3d795dabbf72b95736c5` and in the
[completed backlog entry](../backlog/archive.md).

## Next action and unrelated prerequisite

Proceed sequentially to M6-SSE-API; this durability slice has no remaining work.

`OPS-M5-HEALTH-ACCEPTANCE-DRIFT` remains open and must be resolved before integrated M6
acceptance. It does not invalidate this isolated log-durability acceptance.

## Links

- [M6 plan](../plans/m6-dashboard-live-logs.md#M6-LOG-DURABILITY)
- [Active backlog](../backlog/active.md)
- [Locked product contract](decision-2026-09-16-m6-product-contract.md)
