---
id: RPT-2026-09-13-session-m2-complete
type: session
status: verified
date: 2026-09-13
vault_sync: synced
---

# M2 GitHub App vertical slice completion

## Context

M2 connected GitHub App authentication and installation ownership to authorized repository import and raw-body webhook processing. The work was split among collision-free Luna agents, then integrated and challenged independently by the root orchestrator before acceptance.

## Verified finding

- OAuth uses one-time hashed state, PKCE, a browser-binding cookie, opaque hashed sessions, and encrypted GitHub user credentials. Installation setup verifies both the authenticated user view and the GitHub App view before assigning an immutable first owner.
- Repository listing follows GitHub pagination, preserves only the required pull-permission projection, and revalidates installation, repository identity, pull permission, and the configured Dockerfile before an idempotent import.
- Webhook HMAC is computed over exact raw request bytes. Delivery IDs are durably deduplicated, conflicting reuse rolls back, stale source events cannot rewind desired state, and close creates a durable deletion request.
- The integrated acceptance test runs a real Nest HTTP server against PostgreSQL 18.1 and a controlled GitHub HTTP server. Twelve concurrent copies of one signed delivery produce one accepted delivery, eleven duplicates, and one deployment intent; a signature over a differently serialized body returns 401 and writes nothing.
- No live GitHub account or credential was used. The controlled server proves application protocol behavior deterministically; live GitHub installation smoke testing remains an operator/deployment concern rather than an M2 acceptance dependency.
- A repeated final gate exposed that the older M1 deployment-intent path recognized Prisma `P2034` but not the PostgreSQL adapter's typed raw `40001` shape. The repaired path recognizes only typed `40001`/`40P01` write conflicts, uses bounded jittered retry, and cleans fixture event IDs even when a concurrent command rejects.

## Evidence

- Implementation commits `634128d`, `dddf826`, `e33f144`, `25a1148`, `d1cd42f`, `e678671`, `e265a8b`, and `c4a9825` cover the M2 foundations, webhook, auth/installation, permission repair, compile contracts, import, route alignment, and integrated acceptance wiring.
- `DATABASE_URL=<local redacted value> pnpm check` passed on 2026-09-13: Biome checked 92 files, all 15 Turbo tasks passed, contract tests passed 10/10, API unit tests passed 47/47, database retry/unit tests passed 7/7, PostgreSQL integration tests passed 41/41 across six files, and the real HTTP acceptance test passed 1/1.
- PostgreSQL runtime inspection identified database `previewforge`, schema `public`, server 18.1, three applied migrations, and no pending migration. Acceptance cleanup left users, webhook deliveries, and projects at `0|0|0`.
- Deliberate fault checks failed when safe-integer validation, repository permission projection, account-identity protection, `/api` callback routing, GitHub 404 normalization, raw-byte HMAC verification, or the PostgreSQL Dockerfile path constraint was removed; each production path was restored before the full green run.
- In a disposable migrated database, dropping `projects_dockerfile_path_safe_check` produced one targeted failure because `../Dockerfile` was persisted. The database was then deleted; the primary schema was not modified.
- Root repeated the 12-way real PostgreSQL deployment-intent burst 100 times without failure and confirmed zero orphan deployment outbox rows. Removing `40001` from the typed detector made two focused retry tests fail before restoration.

## Impact / consequences

M2 meets its roadmap acceptance criteria and leaves a runnable vertical slice that converts an authenticated, authorized GitHub pull-request event into exactly one durable desired deployment intent and converts close into deletion intent. M3 can relay the existing outbox to Kafka without moving webhook authority out of PostgreSQL or weakening the desired-SHA guard.

## Prevention / next action

Plan and backlog M3 before implementation. M3 acceptance must use real local Kafka and PostgreSQL, restart/failure injection, durable receipts and leases, retry classification, and deliberate duplicate/stale-message faults; agent-produced evidence remains subject to independent root verification.

## Related links

- [M2 plan](../plans/m2-github-app-vertical-slice.md)
- [Delivery roadmap](../delivery/roadmap.md)
- [Backlog archive](../backlog/archive.md)
- [System design](../architecture/system-design.md)
- [ADR 0002](../architecture/decisions/0002-postgres-outbox-and-kafka.md)
- [Project memory](../knowledge/previewforge-memory.md)
- [VictusOS distillation](../../../../Documents/VictusOS/Reports/PreviewForge/2026-09-13%20M2%20Complete.md)
- [Serialization retry incident](incident-2026-09-13-serialization-retry-leak.md)
