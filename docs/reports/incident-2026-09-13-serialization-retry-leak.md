---
id: RPT-2026-09-13-serialization-retry-leak
type: incident
status: verified
date: 2026-09-13
vault_sync: pending
---

# Serializable deployment-intent retry leak

## Context

The final M2 repository gate reran the existing M1 deployment-intent integration suite against PostgreSQL. A 12-way exact-duplicate burst intermittently leaked a transaction error instead of returning one created result and eleven idempotent duplicates.

## Verified finding

Prisma's PostgreSQL driver adapter surfaced the serialization failure as a typed `DriverAdapterError` with `kind: TransactionWriteConflict` and SQLSTATE `40001`. The repository recognized only Prisma's wrapped `P2034` error, and its four immediate attempts could collide in the same retry wave. When the test rejected before recording its event ID, fixture cleanup also left one orphan test outbox event.

## Evidence

- The failing `pnpm check` reported PostgreSQL `40001`, `TransactionWriteConflict`, and one failure in `deduplicates real concurrent retries to one deployment and one event`.
- Database inspection found exactly one outbox event with an `integration/...` repository fixture and a missing deployment aggregate. Root deleted only that verified UUID; later inspection reported zero orphan deployment outbox rows.
- The repair recognizes `P2034` or the narrow adapter shape `kind: TransactionWriteConflict` with SQLSTATE `40001`/`40P01`; unrelated lookalikes are not retried. Retry remains bounded and exhaustion returns the original error.
- Root verification passed the real 12-way PostgreSQL burst 100/100 times, focused retry behavior 7/7, all database integration tests 41/41, typecheck, and build.
- Deliberately removing `40001` recognition failed two focused tests before the production branch was restored.

## Impact / consequences

At-least-once duplicate deployment commands no longer leak the observed adapter-level serialization race within the bounded retry policy. Test rejection no longer leaves its deterministic outbox key outside cleanup. Persistent or unrelated database failures remain visible rather than being converted to a domain conflict or infinite retry.

## Prevention / next action

Keep typed adapter error-shape tests beside each Serializable repository and retain repeated real-database burst tests at milestone acceptance. M3 worker claims and receipts must use the same bounded, classified retry discipline and must verify cleanup after intentionally failed concurrent tests.

## Related links

- [Deployment intent repository](../../packages/database/src/deployment-intent.ts)
- [Deployment intent PostgreSQL tests](../../packages/database/test/deployment-intent.integration.test.ts)
- [M2 completion report](session-2026-09-13-m2-complete.md)
- [ADR 0002](../architecture/decisions/0002-postgres-outbox-and-kafka.md)
