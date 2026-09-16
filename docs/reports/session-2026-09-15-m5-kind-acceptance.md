---
id: RPT-2026-09-15-session-m5-kind-acceptance
type: session
status: verified
date: 2026-09-16
vault_sync: synced
---

# M5 real kind acceptance and closure

## Outcome

M5 Kubernetes preview reconciliation is complete. A persisted immutable image digest
became a restricted preview reachable through the platform Gateway; rollout availability
and HTTP health gated durable `READY`, while stale desired SHA could not become ready.
Wrong-owner deletion was rejected, repeated owned deletion was safe, and the acceptance
fixtures were cleaned from both Kubernetes and PostgreSQL.

## Acceptance evidence

- On 2026-09-16, `pnpm test:acceptance:m5` passed **1 file / 3 tests** in **81.62s**.
  The disposable runtime identity was database `previewforge_m5_20260915`, kind context
  `kind-previewforge`, local registry `localhost:55000`, and the Envoy Gateway loopback
  forward. The target began from a prebuilt, published immutable digest; it was not a
  local end-to-end rootless BuildKit build.
- The real acceptance observed the exact live owned-resource inventory, namespace
  Restricted labels, quota/limits, NetworkPolicy rule shape, disabled token automount,
  digest-backed Deployment and actual Pod image ID, correct-Host Gateway HTTP 200 with
  nginx body, wrong-Host 404, repeated-apply UID stability, failed rollout and health
  outcomes, desired-SHA supersession, safe deletion, durable post-
  `WAITING_FOR_HEALTHCHECK` failure/outbox event, and fixture cleanup.
- The failed-health fixture now waits for HTTPRoute `Accepted`/`ResolvedRefs`, then
  requires the same preview Host at `/` to return HTTP 200 with an nginx body and at
  `/m5-does-not-exist` to return 404 before starting the bounded health window. This
  avoids treating Envoy's early route-miss 404 as proof that the backend is serving.
  The eventual deterministic 404 remains asserted as durable, non-retryable
  `HEALTHCHECK_FAILED`.
- The Secret test exercised an environment-bearing reconcile followed by an
  environment-free reconcile. The owned Secret and Deployment `envFrom` reference were
  removed, replacement/wrong-owner guards remained, and secret content was not exposed
  in the inspected API/log observations.
- Focused Kubernetes client/reconciler tests passed **2 files / 21 tests**. Worker
  typecheck and `pnpm exec biome check apps/worker/src/m5.acceptance.test.ts` passed.
  Read and mutation deadline tests cover request-scoped cancellation; ownership reads
  are raced against a deadline, and the generated client transport receives the signal.
- `pnpm check` passed: Biome **140 files**; Markdown link check **150 links** and
  active-backlog count **11 before this closure**; Turborepo **15/15**; worker
  **159/159**; database integration **79/79**; API integration **1/1**; worker
  Kafka/PostgreSQL integration **5/5**. The post-acceptance residue check found
  **0 users / 0 deployments / 0 outbox events** in the disposable database and no
  managed preview namespaces.
- Independent final M5 review found no actionable P0/P1 findings in the reviewed
  ownership/deadline, desired-SHA, Secret-prune, durable-failure, or acceptance paths.

The accepted source tree was still uncommitted at HEAD
`769320ae8ba3d11180362564206f611fd9307434`; no commit or push is claimed. Final
closure verification `pnpm docs:check` passed: **146 local Markdown links across 50
files**, 24 repository-external links skipped, and context consistency passed for **7
roadmap milestones, 5 plans, and 0 active backlog entries**.

## Verified repairs and durable lessons

- The immutable digest is persisted on entry to `DEPLOYING` and is not written again
  on the transition to `WAITING_FOR_HEALTHCHECK`.
- kind nodes require an explicit containerd hosts mapping to reach the host's local
  registry; node-local `localhost:55000` alone targets the node itself.
- HTTPRoute acceptance conditions can precede data-plane programming. Health probes
  retry within the rollout deadline and re-check desired SHA before publishing `READY`.
- Network health transport failures remain retryable and distinct from deterministic
  non-2xx health responses. Unexpected worker failures after `WAITING_FOR_HEALTHCHECK`
  persist a guarded, redacted failure or supersede stale work instead of acknowledging
  unfinished state.
- Kubernetes ownership reads and mutations use bounded request-scoped abort signals;
  namespace and Secret deletion carry UID/resourceVersion preconditions. Secret removal
  is limited to the owned observed Secret when environment configuration is absent.
- The generated Kubernetes SDK renames selected Kubernetes wire fields. Live-cluster
  assertions caught and repairs corrected the LimitRange default and NetworkPolicy
  ingress source serialization; see the linked incident reports.

## Boundaries and remaining risks

- The M5 target starts from a prebuilt, published image digest. Rootless BuildKit source
  acquisition/build/push evidence is separate, recorded by [the M4 hosted handoff](session-2026-09-14-m4-hosted-handoff.md).
- PR-close dispatch, TTL cleanup policy, and periodic orphan reconciliation are M7
  work, not M5 deletion-seam scope.
- The local kind kubeconfig had cluster-admin authority. Least-privilege production
  worker RBAC remains unverified and must be checked before M8 cloud deployment.
- The kind run verified NetworkPolicy rule shape, not enforcement by a production CNI;
  negative workload connectivity remains unverified. Production CNI behavior and
  hostile-tenant isolation remain M8 hardening risks.
- VictusOS synchronization is complete in `Reports/PreviewForge/2026-09-16 M5 Complete`.
  Commit/push: not-run; push requires explicit user authorization.

## Related links

- [M5 execution plan](../plans/m5-kubernetes-preview-reconciliation.md)
- [delivery roadmap](../delivery/roadmap.md)
- [active backlog](../backlog/active.md)
- [LimitRange SDK incident](incident-2026-09-15-m5-limitrange-sdk-default.md)
- [NetworkPolicy SDK incident](incident-2026-09-15-m5-networkpolicy-sdk-from.md)
- [M4 hosted handoff](session-2026-09-14-m4-hosted-handoff.md)
