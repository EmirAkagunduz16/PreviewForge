---
id: RPT-2026-09-16-m6-product-contract
type: decision
status: verified
date: 2026-09-16
vault_sync: synced
---

# M6 product-contract decisions

## Context

The M6 plan left environment-variable scope and durable log bounds open because the MVP,
ADR, and current `LogChunk` schema did not define those product choices. The user
explicitly approved the following contract on 2026-09-16. This closes only
`M6-PRODUCT-CONTRACT`; it does not complete or implement M6-ENV-VARS or
M6-LOG-DURABILITY.

## Verified finding

The locked product decisions are:

1. Environment variables are **project-scoped** and **shared by every PR preview** for
   that project. Values remain encrypted at rest and write-only at the API boundary.
2. Log chunk and retention byte counts apply to UTF-8 encoded log `text`:
   - Maximum chunk text: 16 KiB = `16 * 1024` = **16,384 bytes**.
   - Maximum retained log text per deployment: 2 MiB = `2 * 1024 * 1024` =
     **2,097,152 bytes**.
   - Maximum age: **30 days**, with expiry based on persisted `createdAt` and cutoff
     `createdAt < now - 30 days`, not `emittedAt`.
   - Oversized stream input is split at UTF-8 boundaries into chunks within the limit.
     When the total cap is exceeded, evict oldest chunks first, ordered by sequence.
   - If age or total-cap eviction removes history before a reconnect cursor, SSE emits
     an explicit `event: gap` and provides the oldest retained sequence as its resume
     boundary (or the next sequence when no chunks remain). Omitted output must never
     be represented as replayed.

The existing `LogChunk` table has `emittedAt` but no `createdAt`; implementation must
add the `createdAt` field through an additive migration, backfilling any existing rows
from `emittedAt` if present. If pruning could remove every row, the implementation must
also preserve a per-deployment sequence high-water mark so a `gap` can still expose a
valid next-sequence boundary. These are implementation obligations of M6-LOG-DURABILITY,
not additional unresolved product decisions.

No user-provided environment value may enter a build context, image layer, event
payload, API response, or log. PostgreSQL remains authoritative; M6 does not introduce
Redis, WebSockets, terminals, or a new service.

## Evidence

- User approval recorded on 2026-09-16 in the task direction.
- Locked contracts and downstream slice ownership recorded in
  [M6 execution plan](../plans/m6-dashboard-live-logs.md).
- `pnpm docs:check` and `git diff --check` pass after recording the decision.
- M6-ENV-VARS and M6-LOG-DURABILITY are unblocked but not implemented; runtime evidence
  for either remains not-run.

## Impact / consequences

Environment persistence and worker lookup must use project identity across all PR
previews. Log writer, retention, and SSE acceptance must assert the exact byte limits,
`createdAt` age cutoff, oldest-first eviction, and explicit gap event. The missing
`createdAt` and empty-retention high-water mark must be addressed within M6-LOG-DURABILITY.

## Prevention / next action

Continue with one agent sequentially: implement M6-ENV-VARS first, then M6-LOG-DURABILITY;
only after these pass, proceed to SSE, dashboard, and integrated M6 acceptance. Keep M6
active until its complete exit checklist passes. M7 cleanup orchestration and M8
production RBAC/CNI remain deferred.

## Related links

- [M6 execution plan](../plans/m6-dashboard-live-logs.md)
- [M6 Query API report](session-2026-09-16-m6-query-api.md)
- [Active backlog](../backlog/active.md)
- [Archived backlog](../backlog/archive.md)
- [VictusOS M6 Query API distillation](../../../../Documents/VictusOS/Reports/PreviewForge/2026-09-16%20M6%20Query%20API.md)
