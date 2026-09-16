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
lanes. M6-QUERY-API, M6-PRODUCT-CONTRACT, M6-ENV-VARS, M6-LOG-DURABILITY, and M6-SSE-API are
complete and archived with evidence.
The [M6 execution plan](../plans/m6-dashboard-live-logs.md) contains the approved locked
contracts and sequential ownership/acceptance matrix. M6 as a whole remains active.

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
