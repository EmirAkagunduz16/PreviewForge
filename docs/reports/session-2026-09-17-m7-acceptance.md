---
id: RPT-2026-09-17-m7-acceptance
type: session
status: verified
date: 2026-09-17
vault_sync: pending
---

# M7 integrated acceptance — 2026-09-17

## Result

M7 integrated acceptance is verified complete. This was the milestone's real
runtime and delivery closure, not a new cleanup implementation: the existing
focused acceptance fixtures were executed against disposable PostgreSQL, Kafka,
kind, and Envoy Gateway, then the final residue was inspected before archival.

## Acceptance matrix

| Scenario | Evidence | Result |
|---|---|---|
| Repeated PR-close deletion | `environment-deletion.acceptance.test.ts` | 1 file / 2 tests passed; owned namespace deleted once, duplicate close was a durable no-op, wrong owner was preserved. |
| TTL expiry and future expiry | `ttl-sweeper.acceptance.test.ts` | 1 file / 2 tests passed; `ttl_expired` intent, annotation parity, Kafka coordinator deletion, idempotent repeat, and future expiry were verified. |
| DB-missing orphan | `orphan-reconciler.acceptance.test.ts` | 1 test passed; valid managed orphan deleted, malformed/unowned/wrong-owner namespaces preserved. |
| Stale-SHA race and Envoy routing | `m5.acceptance.test.ts` | 1 file / 3 tests passed against kind and Envoy loopback; stale work became `SUPERSEDED`, immutable digest reached the preview, correct Host returned 200 and wrong Host returned 404. |
| At-least-once/retry foundation | `pnpm check` | Biome, docs, Turbo 18/18, database 14 files/98 tests, API 5 files/6 tests, worker M3 1 file/5 tests, and worker unit 25 files/205 tests passed. |

The M7 Check Run identity/recovery and redaction evidence remains covered by the
completed M7-CHECKS slice; M7 cleanup acceptance reuses its PostgreSQL/Kafka
boundary rather than adding a second workflow implementation. No live GitHub
credentials were used.

## Exact runtime commands

```text
DATABASE_URL=postgresql://previewforge:previewforge@localhost:55432/previewforge?schema=public KAFKA_BROKERS=localhost:59092 pnpm --filter @previewforge/worker exec vitest run src/cleanup/environment-deletion.acceptance.test.ts --no-file-parallelism
DATABASE_URL=postgresql://previewforge:previewforge@localhost:55432/previewforge?schema=public KAFKA_BROKERS=localhost:59092 pnpm --filter @previewforge/worker exec vitest run src/cleanup/ttl-sweeper.acceptance.test.ts --no-file-parallelism
DATABASE_URL=postgresql://previewforge:previewforge@localhost:55432/previewforge?schema=public pnpm --filter @previewforge/worker exec vitest run src/cleanup/orphan-reconciler.acceptance.test.ts --no-file-parallelism
DATABASE_URL=postgresql://previewforge:previewforge@localhost:55432/previewforge?schema=public M5_IMAGE_REFERENCE=localhost:55000/m5-fixture/nginx-unprivileged:acceptance-20260915 M5_IMAGE_DIGEST=sha256:4517e9228acbf16f2393f7a3f710be0a0fe056d0c06d382ef557d50dc2abc075 M5_GATEWAY_URL=http://127.0.0.1:18080 KUBE_CONTEXT=kind-previewforge pnpm test:acceptance:m5
DATABASE_URL=postgresql://previewforge:previewforge@localhost:55432/previewforge?schema=public KAFKA_BROKERS=localhost:59092 pnpm check
```

Envoy's data-plane was exposed only through a temporary loopback port-forward;
the port-forward was stopped after the acceptance run.

## Final residue

Read-only PostgreSQL checks returned zero unpublished outbox events, M7 Kafka
delivery rows, M7 deletion requests, M7/M5 fixture users/projects, and the kind
cluster returned zero `previewforge.dev/managed=true` namespaces. No Vitest,
worker, or port-forward process remained. Two historical 2026-09-14 M3
dead-letter delivery rows remain outside M7 scope and were not modified.

## Delivery closure

- `pnpm docs:check` and `git diff --check` pass after the final report/backlog
  changes.
- M7-TTL, M7-ORPHAN, and M7-ACCEPTANCE are archived with evidence; the roadmap
  and project knowledge index now point to M8 as the next milestone.
- The database integration fixture teardown removes TTL-created outbox events,
  preventing acceptance residue from contaminating the worker M3 integration.
- Commit/push is authorized by the user and will be attempted after the final
  staged review. The repository `.git` filesystem may still reject writes even
  with user authorization; that is an execution-environment restriction, not a
  missing product permission.

## Links

- [M7 execution contract](../plans/m7-github-feedback-cleanup.md#M7-ACCEPTANCE)
- [TTL/orphan acceptance report](session-2026-09-17-m7-ttl-orphan.md)
- [Active backlog](../backlog/active.md)
- [Completed backlog](../backlog/archive.md)
