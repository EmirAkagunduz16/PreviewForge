# Active backlog

M8 is the active local-hardening milestone. The planning gate is recorded in
the [M8 execution plan](../plans/m8-hardening-cloud-demo.md). AWS/EKS/ECR is
explicitly deferred to a blocked M9 item; no cloud mutation is part of M8.

~~~yaml
- id: M8-E2E-FAULTS
  status: queued
  title: Prove the local lifecycle with failure injection
  owner: PreviewForge delivery
  depends_on: [M8-FIXTURES]
  acceptance_ref: docs/plans/m8-hardening-cloud-demo.md#M8-E2E-FAULTS
  owned_paths: [apps/api/src/m8.integration.test.ts, apps/worker/src/m8.acceptance.test.ts, apps/worker/src/m8-faults/, apps/api/src/test-support/m8/]
  verification_command: not-run until M8-E2E-FAULTS implementation
  next_action: implement the real local open/synchronize/failure/retry/ready/close workflow and deterministic crash-window injections
  acceptance: durable state, external side effects, redaction, stale-SHA fencing, idempotency, and cleanup remain correct after injected faults and restart
  evidence: not-run
  evidence_commit: not-run

- id: M8-OBS
  status: queued
  title: Add metrics, traces, and operator dashboards
  owner: PreviewForge delivery
  depends_on: [M8-E2E-FAULTS]
  acceptance_ref: docs/plans/m8-hardening-cloud-demo.md#M8-OBS
  owned_paths: [packages/observability/, apps/api/src/observability/, apps/api/src/health.controller.ts, apps/api/src/main.ts, apps/api/src/application.ts, apps/worker/src/observability/, apps/worker/src/main.ts, apps/worker/src/config.ts, infrastructure/observability/, docs/operations/m8-observability.md]
  verification_command: not-run until M8-OBS implementation
  next_action: instrument API/worker boundaries, propagate trace context through Kafka, and provision bounded-label lifecycle dashboards
  acceptance: a real local run produces safe metric samples, linked traces, non-empty dashboard panels, and no secret or unbounded identifier leakage
  evidence: not-run
  evidence_commit: not-run

- id: M8-LOCAL-ACCEPTANCE
  status: queued
  title: Run the local hardening acceptance gate
  owner: PreviewForge delivery
  depends_on: [M8-FIXTURES, M8-E2E-FAULTS, M8-OBS]
  acceptance_ref: docs/plans/m8-hardening-cloud-demo.md#M8-LOCAL-ACCEPTANCE
  owned_paths: [scripts/m8/run-local-acceptance.mjs]
  verification_command: not-run until M8-LOCAL-ACCEPTANCE implementation
  next_action: execute the complete disposable local matrix, restore drill, telemetry checks, pnpm check, and residue/process inspection
  acceptance: local lifecycle, failure injection, observability, restore, and teardown all pass with direct test discovery/counts before cloud work
  evidence: not-run
  evidence_commit: not-run

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
  status: queued
  title: Close M8 local hardening with evidence
  owner: PreviewForge delivery
  depends_on: [M8-LOCAL-ACCEPTANCE]
  acceptance_ref: docs/plans/m8-hardening-cloud-demo.md#M8-ACCEPTANCE
  owned_paths: [docs/reports/session-2026-09-17-m8-acceptance.md, docs/reports/index.md, docs/backlog/active.md, docs/backlog/archive.md, docs/knowledge/previewforge-memory.md]
  verification_command: not-run until all M8 local implementation slices are integrated
  next_action: write the evidence-backed local M8 report, archive only proven slices, and rerun final repository, local, and residue checks without AWS
  acceptance: final docs, local runtime evidence, security checks, dashboard/trace observations, restore result, teardown, and deferred M9 blocker agree without unverified cloud claims
  evidence: not-run
  evidence_commit: not-run
~~~
