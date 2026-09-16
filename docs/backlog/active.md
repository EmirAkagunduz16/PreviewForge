# Active backlog

Only unfinished work belongs here. Update this file before starting work and before handing off.

No unfinished M5 work remains. M6 is the current milestone. M5 completion evidence is in the [M5 execution plan](../plans/m5-kubernetes-preview-reconciliation.md) and [real kind acceptance report](../reports/session-2026-09-15-m5-kind-acceptance.md).

## M6 — dashboard and live logs

Implement remaining slices sequentially with one Luna medium agent; do not run parallel
lanes. M6-QUERY-API and M6-PRODUCT-CONTRACT are complete and archived with evidence.
The [M6 execution plan](../plans/m6-dashboard-live-logs.md) contains the approved locked
contracts and sequential ownership/acceptance matrix. M6 as a whole remains active.

- id: M6-ENV-VARS
  status: queued
  acceptance_ref: docs/plans/m6-dashboard-live-logs.md#M6-ENV-VARS
  owned_paths: [packages/database/prisma/schema.prisma, packages/database/prisma/migrations/, packages/database/src/project-environment-repository.ts, packages/security/, apps/api/src/environment-variables/, apps/api/src/app.module.ts, apps/api/test/, apps/worker/src/config/, apps/worker/src/runtime/, apps/worker/test/, apps/worker/src/kubernetes/]
  verification_command: pnpm --filter @previewforge/database test:integration; pnpm --filter @previewforge/api test; pnpm --filter @previewforge/worker test; real disposable-kind environment injection acceptance
  next_action: Implement project-scoped encrypted storage shared across all PR previews, name-only reads, write-only mutations, and worker-to-preview runtime injection without passing values to BuildKit or events.
  blocker: None; M6-PRODUCT-CONTRACT is approved and archived. Proceed as the next sequential slice.
  acceptance: PostgreSQL/API/worker tests plus real kind prove authenticated project/key-bound ciphertext, owner isolation, redacted API responses, and Pod-only plaintext injection.
  evidence: not-run; implementation has not started.
  evidence_commit: not-run

- id: M6-LOG-DURABILITY
  status: queued
  acceptance_ref: docs/plans/m6-dashboard-live-logs.md#M6-LOG-DURABILITY
  owned_paths: [packages/database/prisma/schema.prisma, packages/database/prisma/migrations/, packages/database/src/log-chunk-repository.ts, packages/database/src/index.ts, packages/database/test/, apps/worker/src/build/, apps/worker/src/config/, apps/worker/test/]
  verification_command: pnpm --filter @previewforge/database test:integration; pnpm --filter @previewforge/worker test; disposable PostgreSQL and real BuildKit streaming fixture
  next_action: After M6-ENV-VARS is accepted, add LogChunk.createdAt by migration and implement UTF-8 bounded durable chunks with 16 KiB chunk, 2 MiB/deployment total, 30-day createdAt retention, oldest-first eviction, and explicit SSE gap boundary.
  blocker: None for product policy; proceed after the preceding M6-ENV-VARS slice because execution remains sequential.
  acceptance: Restart/read tests prove unique ordered chunks of at most 16,384 UTF-8 text bytes, at most 2,097,152 retained text bytes per deployment, age expiry from createdAt older than 30 days, oldest-first eviction, explicit gap and valid next-sequence high-water mark after all rows are evicted, safe plain text, and no environment-value leakage.
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
  blocker: Depends on M6-QUERY-API, M6-ENV-VARS, M6-LOG-DURABILITY, M6-SSE-API, and M6-DASHBOARD.
  acceptance: Real dependency and browser evidence covers every M6 exit criterion; cleanup leaves zero fixture DB rows and no managed namespaces; unavailable dependencies are reported not-run rather than mocked as a pass.
  evidence: not-run; implementation has not started.
  evidence_commit: not-run
