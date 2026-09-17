# Active backlog

M8 is the active local-hardening milestone. The planning gate is recorded in
the [M8 execution plan](../plans/m8-hardening-cloud-demo.md). AWS/EKS/ECR is
explicitly deferred to a blocked M9 item; no cloud mutation is part of M8.

~~~yaml
- id: M8-E2E-FAULTS
  status: needs-review
  title: Prove the local lifecycle with failure injection
  owner: PreviewForge delivery
  depends_on: [M8-FIXTURES]
  acceptance_ref: docs/plans/m8-hardening-cloud-demo.md#M8-E2E-FAULTS
  owned_paths: [apps/api/src/m8.integration.test.ts, apps/worker/src/m8.acceptance.test.ts, apps/worker/src/m8-faults/, apps/api/src/test-support/m8/]
  verification_command: pnpm --filter @previewforge/api exec vitest run src/m8.integration.test.ts && pnpm --filter @previewforge/worker exec vitest run src/m8.acceptance.test.ts --no-file-parallelism
  next_action: restore a local rootless BuildKit runtime and rerun the complete M8 gate before archiving this infrastructure-dependent item
  acceptance: durable state, external side effects, redaction, stale-SHA fencing, idempotency, and cleanup remain correct after injected faults and restart
  evidence: Direct API 1 file/2 tests and worker 1 file/6 tests passed against local PostgreSQL 18.1, Kafka 4.3.1, and a real HTTP Check Run fixture. The final local runner also passed the available API/worker fault matrix, restore/outbox drill, and real kind/Envoy M5 acceptance (1 file/3 tests). Covered raw-body HMAC, duplicate/reordered/stale webhook delivery, before-outbox rollback, outbox publish-before-mark crash, worker offset redelivery, stale-SHA supersession, durable retry, lost Check Run create recovery, redaction, and interrupted cleanup. The local host has no buildkitd/buildctl or BuildKit socket, so the rootless BuildKit acceptance boundary remains unclaimed; prior hosted M4 evidence is not substituted for this local gate.
  evidence_commit: 7d7b609

- id: M8-LOCAL-ACCEPTANCE
  status: needs-review
  title: Run the local hardening acceptance gate
  owner: PreviewForge delivery
  depends_on: [M8-FIXTURES, M8-E2E-FAULTS, M8-OBS]
  acceptance_ref: docs/plans/m8-hardening-cloud-demo.md#M8-LOCAL-ACCEPTANCE
  owned_paths: [scripts/m8/run-local-acceptance.mjs]
  verification_command: node scripts/m8/run-local-acceptance.mjs; pnpm check; pnpm docs:check; git diff --check
  next_action: rerun this gate after a local rootless BuildKit runtime and record the final zero-residue result before archiving
  acceptance: local lifecycle, failure injection, observability, restore, and teardown all pass with direct test discovery/counts before cloud work
  evidence: The runner completed runtime identity checks, API 2/2 M8 tests, worker 6/6 M8 tests, the restore/outbox drill (seed 2 rows, repeat 2 rows, restore 2 rows with 2 pending outbox rows, relay/replay 2/2, pending 2→0), telemetry/dashboard checks, and real M5 kind/Envoy acceptance 3/3. The final repository `pnpm check` passed after formatting, with docs:check and whitespace checks clean. The gate is intentionally not archived because the local host lacks buildkitd/buildctl and no BuildKit socket; the runner therefore does not claim the required rootless BuildKit scenario.
  evidence_commit: 578c160

- id: M9-CLOUD-DEMO
  status: blocked
  title: Deploy the deferred demo to EKS and ECR
  owner: PreviewForge delivery
  depends_on: [M8-LOCAL-ACCEPTANCE, explicit AWS budget approval]
  acceptance_ref: docs/plans/m8-hardening-cloud-demo.md#M9-CLOUD-DEMO
  owned_paths: [infrastructure/eks/, scripts/m8/cloud/, docs/infrastructure/m8-eks-ecr-demo.md, .github/workflows/m8-cloud-demo.yml]
  verification_command: not-run — AWS explicitly deferred
  next_action: obtain explicit maximum spend, billing alert, disposable account/region, and destroy-procedure approval before any AWS preflight or provisioning
  blocker: the user's AWS Free Tier is exhausted and no unapproved cloud spend is authorized
  acceptance: after the future unblock, the fixture reaches EKS READY through an immutable ECR digest, negative RBAC and network-policy probes pass, and close cleanup leaves no cloud demo residue
  evidence: blocked by cost boundary; no AWS calls made
  evidence_commit: not-run

- id: M8-ACCEPTANCE
  status: needs-review
  title: Close M8 local hardening with evidence
  owner: PreviewForge delivery
  depends_on: [M8-LOCAL-ACCEPTANCE]
  acceptance_ref: docs/plans/m8-hardening-cloud-demo.md#M8-ACCEPTANCE
  owned_paths: [docs/reports/session-2026-09-17-m8-acceptance.md, docs/reports/index.md, docs/backlog/active.md, docs/backlog/archive.md, docs/knowledge/previewforge-memory.md]
  verification_command: pnpm check; pnpm docs:check; git diff --check; node scripts/m8/run-local-acceptance.mjs; read-only residue/process inspection
  next_action: keep the canonical report and local gate open until the missing BuildKit prerequisite is restored; M9 remains blocked and untouched
  acceptance: final docs, local runtime evidence, security checks, dashboard/trace observations, restore result, teardown, and deferred M9 blocker agree without unverified cloud claims
  evidence: Canonical report: docs/reports/session-2026-09-17-m8-acceptance.md. It records the completed local implementation slices and available-boundary acceptance, the exact BuildKit gap, teardown evidence, and the explicit no-AWS boundary.
  evidence_commit: 87530bf
~~~
