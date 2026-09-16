# M5 execution plan — Kubernetes preview reconciliation

Status: complete
Owner: PreviewForge delivery
Baseline before planning: `312605534c53a0879b7015fe3af31da7dbaf767d`
Sources: [delivery roadmap](../delivery/roadmap.md), [MVP scope](../product/mvp-scope.md), [system design](../architecture/system-design.md), [ADR 0003](../architecture/decisions/0003-gateway-api.md), [ADR 0004](../architecture/decisions/0004-rootless-buildkit.md), [threat model](../security/threat-model.md), [Kubernetes skill](../../.agents/skills/previewforge-kubernetes/SKILL.md)

Completion evidence: [M5 real kind acceptance and closure report](../reports/session-2026-09-15-m5-kind-acceptance.md).

## Outcome

Move a claimed deployment with a current immutable image digest from the worker into a
policy-constrained, per-preview Kubernetes namespace. The resulting HTTPRoute attaches to the
platform-owned Gateway, rollout and HTTP health checks gate `READY`, and stale deployments cannot
mutate or publish the current preview.

M5 does not create a Kubernetes cluster in production, accept arbitrary manifests or Helm charts,
add multiple containers or persistent storage, publish GitHub checks, or implement PR-close/TTL
cleanup beyond the resource identity and deletion seams needed by reconciliation.

## Locked decisions and invariants

- Use the existing worker process and add a Kubernetes adapter/reconciler; do not add a service
  boundary or Redis.
- Local acceptance uses a disposable kind cluster with a conformant Gateway controller. The
  platform-owned Gateway and its provider-specific GatewayClass configuration stay outside
  generated preview resources.
- Derive namespace and resource names from internal project/environment/deployment IDs, and
  require ownership labels before update or delete.
- Create only the supported resource set: Namespace, ResourceQuota, LimitRange, default-deny
  NetworkPolicy with explicit DNS/Gateway allowances, ServiceAccount with token automount disabled,
  optional Secret, Deployment, ClusterIP Service, and HTTPRoute.
- Apply Restricted Pod Security labels and a restricted pod security context: non-root,
  no privilege escalation, dropped capabilities, RuntimeDefault seccomp, and CPU/memory
  requests and limits.
- Deploy the persisted immutable image digest, never a mutable tag. Re-check the deployment's
  desired SHA immediately before Kubernetes mutation and before publishing `READY`.
- Treat server-side apply, rollout polling, health checks, and deletion as repeatable operations.
  Kubernetes API and network failures are retryable according to the existing deployment policy;
  deterministic policy rejection and failed health responses are durable stage-specific failures.
- Preview workloads must not reach the control-plane, metadata, PostgreSQL, Kafka, or registry
  management endpoints. No Kubernetes API token or platform credential enters a preview pod.

## Dependency waves and ownership

M5-ACCEPTANCE resumes with parallel Luna agents. The root owns shared wiring, the backlog,
the plan, runtime acceptance, independent verification, and completion evidence. Gateway
access and ownership-safe deletion may be implemented in parallel; integrated acceptance
depends on both. Direct acceptance runs exposed a digest-transition incompatibility and a
kind-to-registry address mismatch, now owned as separate repairs. PR-close dispatch, TTL
policy, and the periodic orphan reconciler remain M7.

| Slice | Owned paths | Depends on |
|---|---|---|
| M5-BOOTSTRAP | `infrastructure/kubernetes/`, local cluster scripts, package scripts, bootstrap documentation | M0 foundation, ADR 0003 |
| M5-RECONCILER | `apps/worker/src/kubernetes/`, worker config and deployment pipeline seams, contracts/database changes only if required | M3 claims, M4 immutable digest pipeline, M5-BOOTSTRAP |
| M5-ROLLOUT | `apps/worker/src/kubernetes/`, rollout and HTTP health-check tests, deployment transition integration | M5-RECONCILER |
| M5-ACCEPTANCE | real kind acceptance tests, verification scripts, reports, backlog/archive updates | all previous slices |

### M5-ACCEPTANCE ownership ledger

This ledger protects the dirty M5 worktree that existed before delegation. Baseline commit:
`769320ae8ba3d11180362564206f611fd9307434`; baseline tree:
`bff88d7de891a3cb1c195dfdbda1f6c3624c2ed9`. `git diff --cached --name-only`
was empty. The unstaged tracked paths were `apps/worker/package.json`,
`apps/worker/src/main.ts`, `docs/backlog/active.md`, `docs/backlog/archive.md`,
`docs/knowledge/previewforge-memory.md`, `docs/reports/index.md`, `package.json`,
`packages/database/src/deployment-repository.ts`, and `pnpm-lock.yaml`. The pre-existing
untracked paths were `apps/worker/src/kubernetes/`, `docs/infrastructure/m5-kubernetes.md`,
`docs/plans/m5-kubernetes-preview-reconciliation.md`,
`docs/reports/session-2026-09-14-m5-rollout-kind.md`, `infrastructure/kubernetes/`, and
`scripts/kubernetes/`. All are protected; each owner must preserve its starting content.

```yaml
baseline_commit: 769320ae8ba3d11180362564206f611fd9307434
baseline_tree: bff88d7de891a3cb1c195dfdbda1f6c3624c2ed9
staged_paths: []
waves:
  parallel_implementation:
    M5-GATEWAY-ACCESS:
      owner: luna-medium
      writable: [scripts/kubernetes/gateway-port-forward.sh, docs/infrastructure/m5-kubernetes.md]
      runtime_mutation: root-only
    M5-DELETE-SEAM:
      owner: luna-high
      writable: [apps/worker/src/kubernetes/reconciler.ts, apps/worker/src/kubernetes/client.ts, apps/worker/src/kubernetes/reconciler.test.ts]
      runtime_mutation: root-only
    M5-ACCEPTANCE-DESIGN:
      owner: luna-medium
      writable: []
      mode: read-only
  dependent_implementation:
    M5-REGISTRY-ACCESS:
      owner: luna-medium
      writable: [infrastructure/kubernetes/kind-config.yaml, infrastructure/kubernetes/local-registry-hosts.toml, scripts/kubernetes/connect-local-registry.sh, docs/infrastructure/m5-kubernetes.md]
      discovered_by: second direct M5 acceptance run
      runtime_mutation: root-only
    M5-TRANSITION-REPAIR:
      owner: luna-high
      writable: [apps/worker/src/kubernetes/deployment-reconciler.ts, apps/worker/src/kubernetes/deployment-reconciler.test.ts]
      discovered_by: first direct M5 acceptance run
    M5-HEALTH-RETRY:
      owner: luna-high
      writable: [apps/worker/src/kubernetes/rollout.ts, apps/worker/src/kubernetes/rollout.test.ts]
      discovered_by: fourth direct M5 acceptance run (Gateway returned 404 after HTTPRoute Accepted/ResolvedRefs)
      runtime_mutation: root-only
    M5-WORKER-FAILURE:
      owner: luna-high
      writable: [apps/worker/src/main.ts, apps/worker/src/kubernetes/failure-persistence.ts, apps/worker/src/kubernetes/failure-persistence.test.ts]
      discovered_by: independent high-risk integration review
      runtime_mutation: root-only
  final_review_repairs:
    M5-FINAL-HEALTH:
      owner: luna-high
      writable: [apps/worker/src/kubernetes/rollout.ts, apps/worker/src/kubernetes/rollout.test.ts, apps/worker/src/kubernetes/failure-persistence.ts, apps/worker/src/kubernetes/failure-persistence.test.ts]
      discovered_by: final independent P1 review
      runtime_mutation: root-only
    M5-FINAL-ACCEPTANCE:
      owner: luna-high
      writable: [apps/worker/src/m5.acceptance.test.ts]
      discovered_by: final independent P1 review
      runtime_mutation: root-only
  followup_review_repairs:
    M5-MUTATION-DEADLINE:
      owner: luna-high
      writable: [apps/worker/src/kubernetes/client.ts, apps/worker/src/kubernetes/client.test.ts, apps/worker/src/kubernetes/reconciler.ts, apps/worker/src/kubernetes/reconciler.test.ts]
      discovered_by: independent follow-up P1 review
      runtime_mutation: root-only
    M5-SECRET-PRUNE:
      owner: luna-high
      writable: [apps/worker/src/kubernetes/reconciler.ts, apps/worker/src/kubernetes/reconciler.test.ts]
      depends_on: [M5-MUTATION-DEADLINE]
      discovered_by: independent follow-up conditional P1 review
      runtime_mutation: root-only
    M5-OWNERSHIP-READ-DEADLINE:
      owner: luna-high
      writable: [apps/worker/src/kubernetes/client.ts, apps/worker/src/kubernetes/client.test.ts, apps/worker/src/kubernetes/reconciler.ts, apps/worker/src/kubernetes/reconciler.test.ts]
      depends_on: [M5-MUTATION-DEADLINE, M5-SECRET-PRUNE]
      discovered_by: final independent P1 review
      runtime_mutation: root-only
    M5-ACCEPTANCE:
      owner: luna-medium
      writable: [apps/worker/src/m5.acceptance.test.ts]
      depends_on: [M5-GATEWAY-ACCESS, M5-DELETE-SEAM, M5-REGISTRY-ACCESS, M5-TRANSITION-REPAIR]
root_writable: [docs/plans/m5-kubernetes-preview-reconciliation.md, docs/backlog/active.md, docs/backlog/archive.md, docs/reports/, docs/knowledge/previewforge-memory.md, apps/worker/package.json, package.json, packages/database/src/deployment-repository.ts, pnpm-lock.yaml]
forbidden_to_agents: [AGENTS.md, .agents/, .git/, .env, .env.local, packages/database/prisma/, apps/api/, packages/contracts/]
```

The deletion seam is `KubernetesReconciler.deletePreviewNamespace(environmentId)`: derive
the stable namespace name, read and verify PreviewForge/environment ownership before deleting,
return safely when absent, and use an idempotent Kubernetes delete adapter. It does not consume
close/TTL events or search for orphaned database rows in M5.

### M5-GATEWAY-ACCESS

Risk: An accepted HTTPRoute still has no usable inbound path in kind. Stimulus: forward the
Envoy data-plane Service and request the preview hostname through that Gateway listener.
Oracle: the route reports accepted/resolved references and the Gateway returns the fixture's
HTTP response for the hostname. Fault sensitivity: removing the Host match or forwarding the
wrong Service fails the request. Runtime: real disposable kind and Envoy Gateway. The agent
prepares a repeatable port-forward helper; root runs the cluster proof.

### M5-DELETE-SEAM

Risk: Cleanup deletes another owner's namespace or fails on repeated delivery. Stimulus:
delete an owned namespace twice and attempt deletion with wrong ownership labels. Oracle:
the owned namespace is absent after both calls and the wrong-owner namespace remains.
Fault sensitivity: disabling the label guard makes the wrong-owner case fail. Runtime: real
disposable kind for root sign-off, with focused unit checks during implementation.

### M5-TRANSITION-REPAIR

Risk: the Kubernetes adapter repeats an immutable digest on a transition where the database
contract forbids it, so a real deployment cannot reach rollout or READY. Stimulus: enter
DEPLOYING with a persisted digest, then reconcile against a real DeploymentRepository.
Oracle: WAITING_FOR_HEALTHCHECK and READY are durably reached while the original digest stays
unchanged. Fault sensitivity: reintroducing the second digest write makes the direct PostgreSQL
case fail. Runtime: real local PostgreSQL plus the direct M5 acceptance target.

### M5-REGISTRY-ACCESS

Risk: a digest-backed Deployment cannot pull from the host's local registry because
`localhost:55000` resolves inside the kind node, not the host. Stimulus: push a fixture
manifest by digest to the PreviewForge local registry, then start a kind Pod using
`localhost:55000/...@sha256:...`. Oracle: the node pulls the exact registry digest over
the configured local HTTP mirror and the restricted preview Pod becomes Available.
Fault sensitivity: remove the kind registry host mapping and image pull fails with a
loopback connection error. Runtime: real disposable kind, local registry container, and
containerd. The agent prepares repeatable configuration; root recreates/tests the cluster.

### M5-ACCEPTANCE

The M5-HEALTH-RETRY repair is a separate high-risk rollout slice. A real fourth
acceptance run observed HTTP 404 from the Gateway even though the HTTPRoute parent
reported `Accepted=True` and `ResolvedRefs=True`. A bounded health retry must
permit eventual HTTP success without ever publishing READY for stale desired SHA;
continuous failed responses must still become a durable `HEALTHCHECK` failure.
Restoring single-attempt health handling is the fault-sensitivity check.

Risk: isolated component tests hide a broken build-to-preview lifecycle. Stimulus: persist a
current digest-backed deployment, reconcile twice, reach its preview hostname via Gateway,
change desired SHA during rollout, exercise failed rollout/health responses, and clean up.
Oracle: PostgreSQL transitions and owned Kubernetes resources show no stale READY or mutation,
the Gateway serves the current fixture, and fixture namespaces are absent afterward.
Fault sensitivity: a tag image, removed final SHA guard, or disabled ownership check fails
the direct acceptance target. Runtime: real local PostgreSQL, registry, worker path, kind,
and Envoy Gateway. Any unavailable dependency is recorded as `not-run`, not replaced by a
mock-only pass.

## Acceptance matrix

| Slice | Risk | Stimulus | Observable oracle | Fault sensitivity | Runtime |
|---|---|---|---|---|---|
| M5-BOOTSTRAP | Cluster or Gateway assumptions are undocumented or non-repeatable. | Create and destroy a disposable kind cluster; install the selected conformant Gateway controller; rerun bootstrap. | Cluster reaches the documented readiness state and the platform Gateway is discoverable; repeated bootstrap is safe. | Remove controller readiness or use a non-conformant route and acceptance fails before reconciliation. | Real kind cluster. |
| M5-RECONCILER | A preview can escape its namespace policy, receive credentials, or mutate another preview. | Reconcile a deployment with and without environment variables; repeat apply; inject wrong ownership labels and stale desired SHA. | Exact owned resource set exists with required labels, quotas, network policy, restricted security context, optional redacted Secret, digest image, ClusterIP Service, and Gateway-bound HTTPRoute. Wrong owner and stale SHA are rejected without mutation. | Remove ownership/SHA guards, token automount setting, limits, or default deny and targeted checks fail. | Real Kubernetes API plus unit/render tests. |
| M5-ROLLOUT | `READY` is published before the workload is actually usable. | Exercise available, failed, timed-out, and superseded rollouts; return success and failure health responses. | Deployment availability and configured HTTP health success are both required for `READY`; failures retain stage, stable code, redacted message, and retryability. | Skip rollout/health gating or weaken timeout handling and targeted tests fail. | Real kind workload and HTTP endpoint. |
| M5-ACCEPTANCE | Unit tests hide broken API, routing, or lifecycle behavior. | Build an immutable fixture image, reconcile twice, access its preview hostname, supersede during rollout, and delete/reconcile residue. | Preview is reachable through the Gateway; repeated apply is idempotent; stale work cannot replace current state; cleanup is ownership-safe and leaves no fixture resources. | Replace digest with tag, bypass final SHA check, or delete without ownership verification and acceptance fails. | Real PostgreSQL, worker, registry, kind, Gateway controller. |

## Exit checklist

- Disposable kind bootstrap and conformant Gateway controller are reproducible and documented.
- Reconciliation creates only the approved namespaced resource model with ownership and expiry
  metadata, policy labels, quotas, limits, restricted pod security, and disabled token automount.
- Preview workloads use a ClusterIP Service and one HTTPRoute attached to the platform Gateway.
- Image deployment uses the persisted immutable digest and never a mutable tag.
- Desired-SHA guards run immediately before Kubernetes mutation and `READY` publication.
- Rollout availability plus configurable HTTP health success are required for `READY`; timeout and
  deterministic failure behavior are covered.
- Repeated apply/delete is safe, and wrong-owner resources are not mutated or removed.
- Real-cluster acceptance covers failed rollout, failed health check, supersession during rollout,
  and the reachable preview hostname.
- `pnpm check` passes; Kubernetes claims are backed by real kind evidence rather than manifest-only
  validation.

## Handoff record

```yaml
id: M5-PLAN
status: complete
acceptance_ref: docs/plans/m5-kubernetes-preview-reconciliation.md#Exit checklist
owned_paths: [docs/plans/m5-kubernetes-preview-reconciliation.md, docs/backlog/active.md]
verification_command: pnpm test:acceptance:m5; pnpm check; pnpm docs:check
next_action: Define and add scoped M6 dashboard/live-log slices to docs/backlog/active.md before implementation.
blocker: none
acceptance: All M5 exit criteria are complete, including digest-backed Gateway reachability, repeated apply/delete, failed rollout/health, supersession, Secret pruning, ownership guards, and cleanup.
evidence: Real M5 acceptance passed 1 file/3 tests in 81.62s against disposable PostgreSQL/kind/registry/Envoy; pnpm check passed 15/15 Turbo tasks, worker 159/159, DB 79/79, API 1/1, and worker integration 5/5; final independent review found no M5 P0/P1. See linked report for runtime identity, cleanup, focused checks, and limits.
evidence_commit: 94978ff27fded4547bd79f307dcd331872b7ab49
```
