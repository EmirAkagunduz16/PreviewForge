# Active backlog

Only unfinished work belongs here. Update this file before starting work and before handing off.

No unfinished M5 work remains. M6 is the current milestone. M5 completion evidence is in the [M5 execution plan](../plans/m5-kubernetes-preview-reconciliation.md) and [real kind acceptance report](../reports/session-2026-09-15-m5-kind-acceptance.md).

## M6 — dashboard and live logs

Implement these slices sequentially with one Luna medium agent; do not run parallel
lanes. The query API may start first. `M6-PRODUCT-CONTRACT` blocks environment-variable
and log-persistence implementation until the two user-visible choices are approved in
the [M6 execution plan](../plans/m6-dashboard-live-logs.md). The plan records per-slice
ownership, dependencies, risk/oracle matrix, acceptance, and handoff evidence.

- id: M6-QUERY-API
  status: queued
  acceptance_ref: docs/plans/m6-dashboard-live-logs.md#M6-QUERY-API
  owned_paths: [packages/database/src/dashboard-repository.ts, packages/database/src/index.ts, packages/database/test/, apps/api/src/dashboard/, apps/api/src/app.module.ts, apps/api/test/]
  verification_command: pnpm --filter @previewforge/database test:integration; pnpm --filter @previewforge/api test
  next_action: Add owner-scoped paginated project, active-preview, deployment-history, and deployment-detail projections with PostgreSQL isolation tests.
  blocker: None for this first implementation slice; preserve the existing root-owned dirty paths and sequential ledger.
  acceptance: Real PostgreSQL tests prove owner-only results, absent/non-owner indistinguishability, stable pagination, current preview joins, and attempt/status/failure projections.
  evidence: not-run; implementation has not started.
  evidence_commit: not-run

- id: M6-PRODUCT-CONTRACT
  status: blocked
  acceptance_ref: docs/plans/m6-dashboard-live-logs.md#M6-PRODUCT-CONTRACT
  owned_paths: [docs/plans/m6-dashboard-live-logs.md, docs/backlog/active.md]
  verification_command: pnpm docs:check; git diff --check
  next_action: Obtain explicit user/root decisions on project-wide versus preview-scoped environment variables and finite per-chunk/total/age log bounds plus truncation/gap behavior; record them in the plan before either dependent slice starts.
  blocker: These product decisions are absent from the MVP, ADRs, and current schema; do not silently choose values or scope.
  acceptance: The approved variable scope and explicit finite log retention/truncation policy are recorded as locked decisions in the M6 plan.
  evidence: not-run; decisions are unresolved.
  evidence_commit: not-run

- id: M6-ENV-VARS
  status: queued
  acceptance_ref: docs/plans/m6-dashboard-live-logs.md#M6-ENV-VARS
  owned_paths: [packages/database/prisma/schema.prisma, packages/database/prisma/migrations/, packages/database/src/project-environment-repository.ts, packages/security/, apps/api/src/environment-variables/, apps/api/src/app.module.ts, apps/api/test/, apps/worker/src/config/, apps/worker/src/runtime/, apps/worker/test/, apps/worker/src/kubernetes/]
  verification_command: pnpm --filter @previewforge/database test:integration; pnpm --filter @previewforge/api test; pnpm --filter @previewforge/worker test; real disposable-kind environment injection acceptance
  next_action: After M6-PRODUCT-CONTRACT is approved, implement encrypted owner-scoped storage, name-only reads, write-only mutations, and worker-to-preview runtime injection without passing values to BuildKit or events.
  blocker: Depends on M6-PRODUCT-CONTRACT; wait for approved scope and bounded key/value input contract.
  acceptance: PostgreSQL/API/worker tests plus real kind prove authenticated project/key-bound ciphertext, owner isolation, redacted API responses, and Pod-only plaintext injection.
  evidence: not-run; implementation has not started.
  evidence_commit: not-run

- id: M6-LOG-DURABILITY
  status: queued
  acceptance_ref: docs/plans/m6-dashboard-live-logs.md#M6-LOG-DURABILITY
  owned_paths: [packages/database/src/log-chunk-repository.ts, packages/database/src/index.ts, packages/database/test/, apps/worker/src/build/, apps/worker/src/config/, apps/worker/test/]
  verification_command: pnpm --filter @previewforge/database test:integration; pnpm --filter @previewforge/worker test; disposable PostgreSQL and real BuildKit streaming fixture
  next_action: After M6-PRODUCT-CONTRACT is approved, stream bounded BuildKit output into durable ordered chunks with transactional sequence allocation and approved retention/truncation behavior.
  blocker: Depends on M6-PRODUCT-CONTRACT; the chunk and total-retention budgets are not yet approved.
  acceptance: Restart/read tests prove durable ordered unique chunks, finite approved bounds, explicit truncation/gaps, safe plain-text output, and no environment-value leakage.
  evidence: not-run; implementation has not started.
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
  blocker: Depends on M6-QUERY-API, M6-PRODUCT-CONTRACT, M6-ENV-VARS, M6-LOG-DURABILITY, M6-SSE-API, and M6-DASHBOARD.
  acceptance: Real dependency and browser evidence covers every M6 exit criterion; cleanup leaves zero fixture DB rows and no managed namespaces; unavailable dependencies are reported not-run rather than mocked as a pass.
  evidence: not-run; implementation has not started.
  evidence_commit: not-run
