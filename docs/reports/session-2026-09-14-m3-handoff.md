---
id: RPT-2026-09-14-session-m3-handoff
type: session
status: verified
date: 2026-09-14
vault_sync: synced
---

# M3 Kafka dispatch and worker claims completion

## Context

M3 adds PostgreSQL-backed relay claims, Kafka delivery handling, deployment leases, receipts,
bounded retries, and desired-SHA fencing. PostgreSQL remains the source of truth; Kafka is an
at-least-once transport. Redis, repository acquisition, image build/push, Kubernetes mutation,
health checks, and GitHub check updates remain outside M3.

## Verified finding

The strict contracts, durable schema, outbox relay, and deployment claim slices are complete and
committed through `d6003c1`. The worker's real Kafka/PostgreSQL integration suite passed all four
scenarios: acknowledgement-before-mark recovery, database-commit-before-offset restart,
redacted poison-message dead-lettering, and stale desired-SHA supersession without a lease.

The first restart run exposed a readiness race: metadata became available before partition
leadership stabilized. `waitForKafka` now requires a successful topic-offset read. The corrected
restart acceptance passed 1/1, proving that an intent remains pending in PostgreSQL while Kafka is
unavailable and is published after recovery.

## Evidence

- Contracts: 13/13 direct tests passed; package typecheck/build passed.
- Migration: 3/3 direct PostgreSQL tests passed.
- Database claims: 23/23 direct PostgreSQL tests passed.
- Database outbox: 10/10 direct PostgreSQL tests passed.
- Full database integration: 9 files/77 tests passed with file parallelism disabled to prevent
  shared-fixture interference.
- Worker unit suite: 6 files/71 tests passed; worker typecheck/build passed.
- Worker integration: 4/4 tests passed against Kafka at `localhost:59092` and PostgreSQL at
  `localhost:55432`.
- Fault sensitivity was observed for outbox claim fencing, acknowledgement ordering, attempt
  reservation, consumer offset ordering, and desired-SHA fencing; every guard was restored.
- Restart acceptance: 1/1 passed after the readiness fix; the expected PostgreSQL retry state,
  eventual publish, and cleanup were observed.
- Worker shutdown smoke: process received SIGTERM, logged `worker.stopped`, and exited 0 in
  approximately 3.4 seconds.
- Root `pnpm test:integration`: database 9 files/77 tests, API 1/1, worker 4/4 passed.
- Root `pnpm test:acceptance`: 1/1 passed.
- Root `pnpm check`: Biome, docs consistency, 15/15 Turbo tasks, and all root integration tests
  passed.
- After the failed run, both containers reported healthy and the restart fixture query returned
  zero rows.
- Core committed evidence head: `d6003c1ba84ba32d4e3e1443c111eebed3b19c8b`; the root-owned
  runtime, acceptance, manifest, and reporting changes are verified in the current working tree
  and remain uncommitted so unrelated pre-existing work is not mixed into a commit.

## Impact / consequences

The M3 core and root-owned runtime/acceptance wiring are now verified under the tested duplicate,
retry, lease, receipt, stale-work, broker-restart, and shutdown conditions. The local topology is
one Kafka broker without a persisted Kafka volume, so this work does not prove multi-broker
failover or disk-loss durability.

PreviewForge work now uses one active agent by default. Parallel subagents are disabled for this
project unless Emir explicitly changes that direction; root verification remains mandatory for any
future delegated work.

## Prevention / next action

M3 is archived. The next implementation checkpoint is M4; add its acceptance slice to the active
backlog before editing implementation files. Keep the M3 local-topology limitation visible in any
future production-readiness report.

## Related links

- [M3 plan](../plans/m3-kafka-dispatch-worker-claims.md)
- [Active backlog](../backlog/active.md)
- [Completed slices](../backlog/archive.md)
- [VictusOS M3 handoff](../../../../Documents/VictusOS/Reports/PreviewForge/2026-09-14%20M3%20Handoff.md)
