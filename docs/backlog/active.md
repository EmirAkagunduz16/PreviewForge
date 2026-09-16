# Active backlog

Only unfinished work belongs here. Update this file before starting work and before handing off.

M5 implementation/evidence remains historically complete, but a repeatable full-acceptance
health-classification drift is tracked by `OPS-M5-HEALTH-ACCEPTANCE-DRIFT`; resolve and
reverify it before integrated M6 acceptance. This does not invalidate the historical M5
evidence or focused M6 ENV-VARS proof. See the [M5 execution plan](../plans/m5-kubernetes-preview-reconciliation.md),
[real kind acceptance report](../reports/session-2026-09-15-m5-kind-acceptance.md), and
[health acceptance incident](../reports/incident-2026-09-16-m5-health-acceptance-drift.md).

## M6 — dashboard and live logs

Implement remaining slices sequentially with one Luna medium agent; do not run parallel
lanes. M6-QUERY-API, M6-PRODUCT-CONTRACT, and M6-ENV-VARS are complete and archived
with evidence.
The [M6 execution plan](../plans/m6-dashboard-live-logs.md) contains the approved locked
contracts and sequential ownership/acceptance matrix. M6 as a whole remains active.

- id: M6-LOG-DURABILITY
  status: in-progress
  acceptance_ref: docs/plans/m6-dashboard-live-logs.md#M6-LOG-DURABILITY
  owned_paths: [packages/database/prisma/schema.prisma, packages/database/prisma/migrations/, packages/database/src/log-chunk-repository.ts, packages/database/src/index.ts, packages/database/test/, apps/worker/src/build/, apps/worker/src/config/, apps/worker/test/]
  verification_command: pnpm --filter @previewforge/database test:integration; pnpm --filter @previewforge/worker test; disposable PostgreSQL and real BuildKit streaming fixture
  next_action: Run the real rootless BuildKit/registry log integration fixture using the canonical M4 hosted-runner environment; verify logs by reading them from a fresh repository instance. Fix any runtime failures, then record final evidence before starting M6-SSE-API.
  blocker: Real BuildKit runtime is unavailable in the local environment (`buildctl` and a local daemon are absent). Do not claim BuildKit acceptance until the real fixture runs. Before integrated M6 acceptance, also resolve and reverify OPS-M5-HEALTH-ACCEPTANCE-DRIFT against the full real M5 target.
  acceptance: Restart/read tests prove unique ordered chunks of at most 16,384 UTF-8 text bytes, at most 2,097,152 retained text bytes per deployment, age expiry from createdAt older than 30 days, oldest-first eviction, explicit gap and valid next-sequence high-water mark after all rows are evicted, safe plain text, and no environment-value leakage.
  evidence: Partial implementation evidence recorded in docs/reports/session-2026-09-16-m6-log-durability-checkpoint.md: migration applied to disposable PostgreSQL; repository integration 6/6; full pnpm check passed (database integration 87, API integration 3, worker integration 5; worker unit 170); real BuildKit fixture not-run because no local daemon/buildctl is available.
  evidence_commit: not-run

- id: M6-SSE-API
  status: queued
  acceptance_ref: docs/plans/m6-dashboard-live-logs.md#M6-SSE-API
  owned_paths: [apps/api/src/live-output/, apps/api/src/app.module.ts, apps/api/test/, packages/database/src/log-chunk-repository.ts]
  verification_command: pnpm --filter @previewforge/api test; real HTTP SSE integration over disposable PostgreSQL
  next_action: After M6-QUERY-API and M6-LOG-DURABILITY, add authenticated owner-scoped replay/live SSE using Last-Event-ID, a PostgreSQL status reread, explicit retention-gap event, heartbeat, and disconnect cleanup.
  blocker: Depends on M6-QUERY-API and M6-LOG-DURABILITY.
  acceptance: Real HTTP stream verifies replay cursor, new chunks and status, expired-cursor gap, cross-owner denial, reconnect behavior, and prompt resource release.
  evidence: not-run; implementation has not started.
  evidence_commit: not-run

- id: M6-DASHBOARD
  status: queued
  acceptance_ref: docs/plans/m6-dashboard-live-logs.md#M6-DASHBOARD
  owned_paths: [apps/web/app/, apps/web/next.config.ts, apps/web/test/]
  verification_command: pnpm --filter @previewforge/web test; authenticated browser acceptance against API and PostgreSQL
  next_action: After M6-QUERY-API, M6-ENV-VARS, and M6-SSE-API, implement project/preview/history/detail navigation, resumable logs, and a write-only key editor.
  blocker: Depends on M6-QUERY-API, M6-ENV-VARS, and M6-SSE-API; same-origin browser/API routing must preserve the existing session cookie.
  acceptance: Browser/network assertions prove owner-scoped views, stage/history rendering, refresh/reconnect, secret redaction, key mutation, loading/error states, and sign-out.
  evidence: not-run; implementation has not started.
  evidence_commit: not-run

- id: M6-ACCEPTANCE
  status: queued
  acceptance_ref: docs/plans/m6-dashboard-live-logs.md#M6-ACCEPTANCE
  owned_paths: [apps/api/src/m6.integration.test.ts, apps/web/test/]
  verification_command: pnpm check; real disposable PostgreSQL/Kafka/BuildKit/registry/kind/Gateway/browser acceptance
  next_action: After all prior slices pass their narrow gates, run the integrated owner/non-owner, secret write-only/runtime, log replay/reconnect, and durable failure workflow; capture actual runtime evidence and residue checks.
  blocker: Depends on M6-QUERY-API, M6-ENV-VARS, M6-LOG-DURABILITY, M6-SSE-API, and M6-DASHBOARD; OPS-M5-HEALTH-ACCEPTANCE-DRIFT must be resolved and the full real M5 acceptance rerun green first.
  acceptance: Real dependency and browser evidence covers every M6 exit criterion; cleanup leaves zero fixture DB rows and no managed namespaces; unavailable dependencies are reported not-run rather than mocked as a pass.
  evidence: not-run; implementation has not started.
  evidence_commit: not-run

- id: OPS-M5-HEALTH-ACCEPTANCE-DRIFT
  status: open
  acceptance_ref: docs/reports/incident-2026-09-16-m5-health-acceptance-drift.md#required-investigation-and-acceptance
  owned_paths: [apps/worker/src/m5.acceptance.test.ts, apps/worker/src/kubernetes/rollout.ts, docs/reports/incident-2026-09-16-m5-health-acceptance-drift.md, docs/backlog/active.md]
  verification_command: pnpm test:acceptance:m5
  next_action: Trace the health fixture's per-attempt HTTP status/timing and Gateway backend readiness across the bounded observation window in the full target; repair the fixture/runtime observation path without relaxing the HEALTHCHECK_FAILED expectation, then rerun the complete real M5 acceptance.
  blocker: None for investigation. Must be resolved and the full target reverified before integrated M6 acceptance; focused M6 ENV-VARS evidence and historical M5 completion remain valid.
  acceptance: Two consecutive real disposable-environment runs classify continuous failed-health responses as durable nonretryable HEALTHCHECK_FAILED, pass all three M5 tests, and leave zero fixture rows and managed namespaces.
  evidence: Repeated full runs each passed 2/3; health case expected HEALTHCHECK_FAILED but got HEALTHCHECK_TIMEOUT at apps/worker/src/m5.acceptance.test.ts:209. Focused ENV-VARS kind case passed; post-run database residue was 0/0/0/0 and no managed namespaces.
  evidence_commit: not-run
