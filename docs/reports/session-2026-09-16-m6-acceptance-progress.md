---
id: RPT-2026-09-16-m6-acceptance
type: session
status: verified
date: 2026-09-16
vault_sync: synced
---

# M6 integrated acceptance — 2026-09-16

## Result

M6 integrated acceptance is verified complete. The final run used the dedicated
PostgreSQL database `previewforge_m6_20260916`, the existing disposable Kafka service,
rootless BuildKit v0.33.0 with a loopback-only registry v3.1.1, the `kind-previewforge`
cluster with Envoy Gateway, and the local Next.js/NestJS browser stack. All fixture rows
and managed preview namespaces were removed before the database was dropped.

## Acceptance evidence

- `pnpm --filter @previewforge/api test:integration` — **5 files / 6 tests passed** on
  the dedicated migrated database. Owner/foreign isolation, encrypted write-only values,
  durable redacted failure, durable logs, SSE cursor replay, and fixture cleanup passed.
- `PATH=/var/tmp/previewforge-m6-buildkit/bin:$PATH BUILDKIT_ADDR=unix:///var/tmp/previewforge-m6-buildkit/runtime/buildkitd.sock REGISTRY_URL=127.0.0.1:5000 REGISTRY_PROTOCOL=http DATABASE_URL=postgresql://previewforge:previewforge@localhost:55432/previewforge_m6_20260916 pnpm --filter @previewforge/worker test:build:integration` — **1/1 passed**.
  The real rootless BuildKit worker built and pushed an immutable image, streamed output
  into PostgreSQL, and a fresh repository instance read ordered non-empty chunks without
  the secret sentinel. `buildctl debug workers` and the Unix socket were verified before
  the test.
- `DATABASE_URL=postgresql://previewforge:previewforge@localhost:55432/previewforge_m6_20260916 M5_IMAGE_REFERENCE=localhost:55000/m5-fixture/nginx-unprivileged:acceptance-20260915 M5_IMAGE_DIGEST=sha256:4517e9228acbf16f2393f7a3f710be0a0fe056d0c06d382ef557d50dc2abc075 M5_GATEWAY_URL=http://127.0.0.1:18080 KUBE_CONTEXT=kind-previewforge pnpm test:acceptance:m5` — **1 file / 3 tests passed**.
  The immutable digest reached a restricted preview through Envoy Gateway; repeated apply,
  health/rollout failures, stale-SHA supersession, ownership-safe deletion, Secret pruning,
  and cleanup passed.
- Browser runtime acceptance used the dedicated DB with a real Next.js same-origin proxy and
  Nest API. The browser showed the owner project, active PR preview, two-attempt history,
  ordered stages, immutable digest, durable logs after refresh/reselect, and redacted failure
  metadata. A write-only key save rendered the key name but never the submitted value in the
  DOM; sign-out returned to the GitHub sign-in CTA and hid project data.
- Final residue checks after browser and kind cleanup reported zero rows in all tracked
  acceptance tables: `users`, `installations`, `projects`, `pull_requests`,
  `preview_environments`, `deployments`, `log_chunks`,
  `project_environment_variables`, `outbox_events`, `sessions`, `oauth_states`,
  `webhook_deliveries`, `kafka_deliveries`, `consumer_receipts`, and
  `environment_deletion_requests`. The three OAuth rows produced by the disposable
  database-repository test run were removed before the zero snapshot; the dedicated
  database was then dropped. No `pf-*` namespaces, temporary BuildKit runtime/socket,
  API/web/Gateway-forward/BuildKit processes, or leaked timeout-test process remained.

## Repository verification

- `pnpm --filter @previewforge/api exec vitest run src/api-exception.filter.test.ts --no-file-parallelism` — 3/3 passed.
- `pnpm --filter @previewforge/api typecheck` and API build — passed.
- Final `pnpm check` passed: Biome 176 files; docs 204 local links across 59 files and
  context consistency (8 roadmap milestones, 6 plans, 1 active backlog entry); Turbo
  18/18; API unit 60/60; worker unit 171/171; database integration 87/87; API
  integration 6/6; worker Kafka/PostgreSQL integration 5/5; all typechecks and builds.

## Resolved runtime issue

During forced teardown with an open browser SSE connection, the API attempted to write a
second JSON error envelope after the stream headers were committed. The exception filter now
ignores committed, destroyed, or ended responses, with a regression test; normal SSE
disconnect handling remains covered by the live-output integration suite.

## Scope and limits

M6 closes dashboard/history, durable BuildKit logs, resumable SSE, encrypted write-only
environment values, and the real kind/Gateway runtime seam. M7 PR-close/TTL/orphan cleanup,
GitHub check runs, production RBAC/CNI enforcement, metrics/traces, and cloud deployment
remain out of scope. The kind cluster and local Compose services are disposable test
infrastructure and are not production isolation evidence.

## Links

- [M6 plan](../plans/m6-dashboard-live-logs.md#M6-ACCEPTANCE)
- [M6 dashboard evidence](session-2026-09-16-m6-dashboard.md)
- [M6 log durability evidence](session-2026-09-16-m6-log-durability-checkpoint.md)
- [M6 SSE evidence](session-2026-09-16-m6-sse-api.md)
- [M5 health drift resolution](incident-2026-09-16-m5-health-acceptance-drift.md)
- [Active backlog](../backlog/active.md)
