# M7 execution plan — GitHub feedback and cleanup

Status: complete
Owner: PreviewForge delivery
Baseline before planning: `a8c4a72` (`main` = `origin/main`); protected untracked `.codex/` is not part of this work.
Sources: [MVP scope](../product/mvp-scope.md), [delivery roadmap](../delivery/roadmap.md), [system design](../architecture/system-design.md), [deployment state machine](../architecture/deployment-state-machine.md), [ADR 0002](../architecture/decisions/0002-postgres-outbox-and-kafka.md), [ADR 0003](../architecture/decisions/0003-gateway-api.md), [M2 plan](m2-github-app-vertical-slice.md), [M5 plan](m5-kubernetes-preview-reconciliation.md), [control-plane skill](../../.agents/skills/previewforge-control-plane/SKILL.md), and [Kubernetes skill](../../.agents/skills/previewforge-kubernetes/SKILL.md).
Planning gate: `M7-PLAN` is complete when this contract, ownership ledger, acceptance matrix, and exit checklist are recorded; product implementation begins with `M7-CHECKS`.
Completion evidence: [M7 integrated acceptance report](../reports/session-2026-09-17-m7-acceptance.md).

## Outcome

M7 completes the remaining MVP feedback and lifecycle behavior:

- create and update one GitHub Check Run per deployment with stage progress, a
  preview link after `READY`, and a redacted failure summary;
- execute the existing pull-request-close deletion intent through the worker;
- apply a bounded preview TTL and route expiry through the same durable cleanup
  path; and
- periodically find and remove only safely identified PreviewForge orphan
  namespaces whose database state is missing or terminal.

The API remains one NestJS control-plane application and the worker remains the
single independently scalable process for builds, Kubernetes reconciliation,
GitHub feedback, and cleanup. M7 does not add a service, Redis, a second workflow
store, arbitrary Kubernetes manifests, or production/cloud deployment.

## Locked decisions and MVP boundary

### Source of truth and delivery

- PostgreSQL remains authoritative. Kafka and the transactional outbox remain
  at-least-once transports; offsets are never treated as lifecycle state.
- Every cleanup and Check Run side effect has a durable identity, an atomic
  claim/guard, and a retry classification. A worker crash between an external
  call and acknowledgement must be recoverable without changing the desired
  deployment state.
- Existing `environment.deletion-requested.v1` is the cleanup command boundary.
  M2 already records the pull-request-close intent; M7 executes it and records
  `REQUESTED`, `PROCESSING`, `COMPLETED`, `FAILED`, or `CANCELLED` durably.
- The existing M5 `KubernetesReconciler.deletePreviewNamespace` seam remains the
  only namespace deletion operation. M7 must not issue an unowned or broad
  cluster delete.

### GitHub Check Run contract

- There is one logical Check Run for each deployment attempt. The persisted
  `Deployment.checkRunId` is the stable remote identity once GitHub has accepted
  the create call.
- The worker resolves repository, installation, pull-request, and current
  deployment metadata from PostgreSQL before calling GitHub. Deployment event
  payloads remain identifier-only; no credential or environment value is added
  to Kafka messages.
- The status mapping is deterministic and never regresses because of a delayed
  event:

  | Deployment state | GitHub Check Run state | Conclusion | Required output |
  |---|---|---|---|
  | `QUEUED` | `queued` | absent | deployment SHA and pull-request identity |
  | Any non-terminal active state | `in_progress` | absent | current stage and deployment SHA |
  | `READY` | `completed` | `success` | immutable digest and preview URL |
  | `FAILED` | `completed` | `failure` | redacted stage, stable code, message, and retryability |
  | `SUPERSEDED` | `completed` | `neutral` | newer desired SHA superseded this attempt |
  | `CANCELLED` | `completed` | `cancelled` | cancellation reason without secret values |

- The remote identity recovery path uses a deterministic deployment identity
  when looking up an existing Check Run before creating one. If a response is
  lost after GitHub creates the run, the next delivery must discover and reuse
  that run before attempting another create. A database claim alone is not
  considered sufficient protection against the external-call crash window.
- `PREVIEW_BASE_DOMAIN` becomes the single configured source for user-facing
  preview URLs. One helper must produce the same stable host for the Gateway
  route, health-check URL construction, and Check Run output. The URL is not
  user-controlled; production configuration must use an HTTPS-compatible
  public domain, while local acceptance may use the existing local domain.
- A preview link is published only when the deployment is durably `READY`.
  Failure output uses the already redacted durable failure fields and never
  includes installation tokens, private keys, environment values, or raw
  upstream response bodies.
- M7 requires the GitHub App `checks: write` permission and no broader
  repository/admin, Actions, secrets, organization-administration, or OAuth
  scope. Local acceptance uses a controlled GitHub HTTP fixture; live GitHub
  credentials are not required.

### Cleanup contract

- Pull-request close, TTL expiry, and orphan recovery converge on the same
  ownership-safe deletion coordinator. Webhook handling and TTL scanning do not
  call Kubernetes directly.
- Close and expiry requests are idempotent by environment/request identity.
  Repeated events, Kafka redelivery, and a worker restart cannot produce a
  second destructive action or a second terminal settlement.
- Reopen/synchronize handling is serialized with cleanup authority. A stale
  close or TTL request must not delete a preview after a newer open event has
  reactivated that environment. If cleanup wins the race, the new desired
  deployment must be able to recreate the preview through the normal desired-SHA
  path; if reactivation wins, the stale request is cancelled before deletion.
- `expiresAt` is assigned by the accepted API/webhook transaction using a
  bounded configured TTL. A newer accepted desired commit refreshes the same
  environment's expiry; closing the pull request always takes precedence over
  TTL. The initial implementation default is 24 hours, with explicit bounded
  configuration for tests and operators.
- The periodic orphan scan selects only resources carrying the established
  PreviewForge managed label. For each candidate it validates the UUID-derived
  namespace name and ownership labels, then checks PostgreSQL by environment ID.
  A missing database row or a terminal cleanup state is eligible for deletion;
  an invalid name, missing ownership label, ownership conflict, or API timeout
  is left in place and recorded as a safe skip/retryable observation.
- Cleanup failures persist a bounded, redacted reason. Ownership conflicts are
  fail-closed and never repaired by stripping labels or using privileged,
  unconfined, Docker-socket, or global cluster-policy shortcuts.

## Dependency waves and ownership

All work is performed sequentially by the root agent. The ledger still makes
shared paths and the intended implementation boundaries explicit.

```yaml
root_owned:
  - docs/plans/m7-github-feedback-cleanup.md
  - docs/backlog/active.md
  - docs/backlog/archive.md
  - docs/knowledge/previewforge-memory.md
  - package.json
  - pnpm-lock.yaml
  - .env.example
  - apps/api/src/app.module.ts
  - apps/api/src/config.ts
  - apps/worker/src/main.ts
  - apps/worker/src/config.ts
  - final acceptance fixtures and reports

M7-CHECKS:
  depends_on: [M6]
  owned:
    - apps/worker/src/github-checks/**
    - apps/worker/src/preview-url.ts
    - apps/worker/src/kubernetes/resource-renderer.ts
    - apps/worker/src/kubernetes/deployment-reconciler.ts
    - apps/worker/src/github-checks.test.ts
    - packages/database/src/deployment-feedback-repository.ts
    - packages/database/test/deployment-feedback-repository.integration.test.ts
    - packages/database/src/deployment-repository.ts
    - packages/contracts/src/kafka.ts
    - packages/contracts/test/kafka.test.ts

M7-PR-CLOSE:
  depends_on: [M7-CHECKS]
  owned:
    - packages/database/src/environment-deletion-repository.ts
    - packages/database/test/environment-deletion-repository.integration.test.ts
    - packages/database/src/webhook-repository.ts
    - packages/database/test/webhook-repository.integration.test.ts
    - apps/worker/src/cleanup/environment-deletion-consumer.ts
    - apps/worker/src/cleanup/environment-deletion-consumer.test.ts
    - apps/worker/src/cleanup/environment-deletion.acceptance.test.ts
    - apps/worker/src/kafka/**

M7-TTL:
  depends_on: [M7-PR-CLOSE]
  owned:
    - apps/api/src/app.module.ts
    - apps/worker/src/config.ts
    - apps/worker/src/main.ts
    - apps/api/src/webhooks/**
    - packages/contracts/src/github.ts
    - packages/contracts/src/kafka.ts
    - packages/database/src/webhook-repository.ts
    - packages/database/src/environment-deletion-repository.ts
    - packages/database/src/project-environment-repository.ts
    - packages/database/prisma/migrations/*_m7_cleanup/**
    - packages/database/prisma/schema.prisma
    - apps/worker/src/cleanup/ttl-sweeper.ts
    - apps/worker/src/cleanup/ttl-sweeper.test.ts
    - apps/worker/src/cleanup/ttl-sweeper.acceptance.test.ts

M7-ORPHAN:
  depends_on: [M7-PR-CLOSE]
  owned:
    - apps/worker/src/config.ts
    - apps/worker/src/main.ts
    - apps/worker/src/cleanup/orphan-reconciler.ts
    - apps/worker/src/cleanup/orphan-reconciler.test.ts
    - apps/worker/src/cleanup/orphan-reconciler.acceptance.test.ts
    - apps/worker/src/kubernetes/client.ts
    - apps/worker/src/kubernetes/reconciler.ts
    - apps/worker/src/kubernetes/resource-renderer.ts
    - packages/database/src/environment-deletion-repository.ts

M7-ACCEPTANCE:
  depends_on: [M7-CHECKS, M7-PR-CLOSE, M7-TTL, M7-ORPHAN]
  owned:
    - apps/worker/src/cleanup/environment-deletion.acceptance.test.ts
    - apps/worker/src/cleanup/ttl-sweeper.acceptance.test.ts
    - apps/worker/src/cleanup/orphan-reconciler.acceptance.test.ts
    - apps/worker/src/m3.integration.test.ts
    - apps/worker/src/m5.acceptance.test.ts
    - packages/database/test/environment-deletion-repository.integration.test.ts
    - docs/reports/session-2026-09-17-m7-acceptance.md
    - docs/reports/index.md
    - docs/knowledge/previewforge-memory.md
    - docs/backlog/active.md
    - docs/backlog/archive.md
```

Shared wiring and any migration/export file are root-owned even when a slice
introduces the underlying module. A slice must not broaden its paths without
updating this ledger and the active backlog first.

## Slice contracts

### M7-PLAN

- Status: complete for this planning step; M7 is now complete with the integrated acceptance evidence recorded below.
- Objective: record the M7 boundary, dependency order, ownership ledger,
  runtime acceptance rows, security invariants, and exit checklist before
  implementation files change.
- Acceptance: this plan exists, links the prior accepted decisions, defines
  every unfinished M7 slice, and the active backlog points to the first
  implementation action.
- Verification: `pnpm docs:check` and `git diff --check`.

### M7-CHECKS

- Dependency: M6 integrated acceptance and this planning gate.
- Status: complete on 2026-09-17. Controlled Check Run HTTP, PostgreSQL
  identity/recovery, Kafka delivery, redaction, duplicate/reordered-event, and
  shared preview URL tests passed; the repository-wide `pnpm check` also passed
  against the local PostgreSQL/Kafka services.
- Objective: add the worker-side GitHub Checks boundary and durable state seam.
  Reuse the existing installation-token topology, but keep token acquisition
  and Check Run HTTP calls outside the BuildKit context.
- Required behavior: create or recover one Check Run per deployment, update it
  from the authoritative current deployment state, preserve the desired-SHA
  guard, map terminal states as specified above, and retry transient GitHub
  failures without logging credentials or response bodies.
- Required tests: controlled GitHub HTTP responses for create, update, list/
  recovery after a lost create response, 401/403, rate limit, 5xx, malformed
  response, duplicate event, delayed event, and redaction. PostgreSQL tests
  must cover concurrent identity claim and stored `checkRunId` reuse.
- Acceptance: a repeated or reordered deployment-event delivery produces one
  logical Check Run whose final observation matches PostgreSQL, and `READY`
  output contains the immutable digest plus the correct preview URL.

### M7-PR-CLOSE

- Dependency: M7-CHECKS; existing M2 close event and M5 delete seam are the
  baseline, not new work to redesign.
- Status: complete on 2026-09-17. PostgreSQL/Kafka/kind acceptance passed for
  owned deletion, repeated close no-op, wrong-owner refusal, and final residue
  inspection; repository-wide checks passed.
- Objective: consume `environment.deletion-requested.v1` from the existing
  environment command topic, claim the matching deletion request atomically,
  call the ownership-safe namespace deletion seam, and settle the request.
- Required behavior: repeated close events, duplicate Kafka delivery, missing
  namespace, worker restart, and already-completed requests are safe; wrong
  ownership and timeout are never converted into a successful delete.
- Race behavior: a newer reopen is checked before the destructive Kubernetes
  mutation and cancels stale work when possible. A cleanup claim that wins must
  leave a durable state from which the next open/synchronize can safely create a
  new desired deployment.
- Acceptance: real PostgreSQL/Kafka/kind evidence proves a close request is
  eventually completed, the namespace is gone, the second close is a no-op,
  and a wrong-owner namespace remains untouched.

### M7-TTL

- Dependency: M7-PR-CLOSE's deletion coordinator.
- Status: complete on 2026-09-17. Migration, bounded TTL sweep, PostgreSQL/Kafka
  intent creation, Kubernetes expiry annotation, and real PostgreSQL/Kafka/kind
  acceptance passed; evidence is recorded in the [TTL and orphan cleanup
  report](../reports/session-2026-09-17-m7-ttl-orphan.md).
- Objective: assign and refresh `expiresAt` in the API/webhook transaction,
  render the expiry metadata consistently, and run a bounded periodic sweep in
  the existing worker process.
- Required behavior: only an expired `ACTIVE` environment creates an actionable
  cleanup request; non-expired and reopened environments are untouched; a
  repeated sweep is idempotent; close and TTL reasons remain distinguishable in
  durable records and safe logs.
- Acceptance: a disposable environment with a controlled past expiry produces
  exactly one cleanup intent and is removed through the same path as PR close;
  a future expiry survives the sweep; the expiry label/annotation matches the
  database timestamp.

### M7-ORPHAN

- Dependency: M7-PR-CLOSE's deletion coordinator and M5 ownership checks.
- Status: complete on 2026-09-17. Bounded managed-namespace listing, DB state
  validation, UID/resourceVersion-safe deletion, and real kind/PostgreSQL
  acceptance passed; evidence is recorded in the [TTL and orphan cleanup
  report](../reports/session-2026-09-17-m7-ttl-orphan.md).
- Objective: list only PreviewForge-managed namespaces, validate exact
  UUID-derived identity and labels, and remove a labeled namespace whose
  environment row is absent or terminally cleaned up.
- Required behavior: pagination/bounded scan, retryable Kubernetes reads,
  UID/resourceVersion-safe deletion, safe handling of NotFound, and explicit
  skip for an invalid or wrong-owner candidate. No label stripping or broad
  namespace deletion is allowed.
- Acceptance: real kind creates a labeled orphan with no database row; one
  reconciliation removes it. An unowned or malformed namespace remains, and
  the run leaves no unrelated fixture resources.

### M7-ACCEPTANCE

- Dependency: all preceding M7 slices.
- Status: complete on 2026-09-17. The real acceptance matrix and final residue
  inspection passed; evidence is recorded in the [integrated acceptance
  report](../reports/session-2026-09-17-m7-acceptance.md).
- Objective: prove the complete lifecycle against disposable real dependencies
  and record the report before moving M7 to the archive.
- Required workflow: open, synchronize race, build/deploy failure, `READY` with
  immutable digest and Check Run preview link, repeated close, close during
  active work, reopen race, TTL expiry, orphan removal, wrong-owner refusal,
  GitHub retry/recovery, and final residue inspection.
- Required evidence: controlled GitHub HTTP fixture, real PostgreSQL, Kafka,
  worker, registry/BuildKit where the deployment path is exercised, real kind
  and Envoy Gateway for namespace/route cleanup, `pnpm check`, `pnpm docs:check`,
  `git diff --check`, and zero disposable rows/namespaces/processes after
  teardown. A mock-only or manifest-only result is not end-to-end evidence.

## Acceptance matrix

| Slice | Risk | Stimulus | Observable oracle | Fault sensitivity | Runtime |
|---|---|---|---|---|---|
| M7-CHECKS | Duplicate or delayed events create duplicate checks, regress a terminal result, leak credentials, or publish a false preview link. | Drive each deployment transition through a controlled GitHub API fixture; replay, reorder, duplicate, and lose the create response. | One logical Check Run per deployment; current PostgreSQL status wins; `READY` shows digest/link; `FAILED` shows only redacted fields; retryable upstream failures remain retryable. | Remove identity recovery, use event status instead of current state, or log the token/response and the targeted test must fail. | Controlled GitHub HTTP fixture, disposable PostgreSQL/Kafka, worker. |
| M7-PR-CLOSE | Close delivery or worker crash leaks a namespace, deletes another preview, or lets stale close work win after reopen. | Close the same PR repeatedly, interrupt between claim and Kubernetes delete, use an absent namespace, wrong ownership, and reopen before deletion. | One durable request; repeated delivery is a no-op; owned namespace is eventually absent; wrong-owner namespace remains; reopen/close race is serialized. | Remove the event receipt, CAS claim, or ownership check and the direct target fails before restoration. | Disposable PostgreSQL/Kafka, real kind/Envoy Gateway, worker. |
| M7-TTL | Expiry is missing, refreshed incorrectly, deletes a live preview, or creates unbounded duplicate work. | Create future, past, and refreshed expiries; run the sweep repeatedly and race it with synchronize/close. | Only expired active environments enqueue cleanup; exactly one request identity is actionable; annotation and DB time agree; close reason remains distinct. | Remove the expiry predicate or use local process time as authority and the database/runtime target fails. | API + disposable PostgreSQL/Kafka, worker, real kind for deletion. |
| M7-ORPHAN | A reconciler either leaves leaked previews or deletes an unrelated namespace. | Create a valid labeled orphan, an active DB-backed preview, a malformed name, and a wrong-owner resource; run repeated scans. | Only the valid labeled orphan is removed; active and invalid/wrong-owner resources remain; UID/resourceVersion race does not delete a replacement. | Remove managed-label/name/owner validation and the real kind target fails. | Disposable PostgreSQL and real kind/Envoy Gateway. |
| M7-ACCEPTANCE | Unit and fake-HTTP success hides a broken full lifecycle or residue. | Run the complete workflow with duplicate/reordered events, failure, ready, close, TTL, orphan, retry, and teardown. | GitHub feedback, durable DB state, immutable digest, routed preview, idempotent deletion, orphan cleanup, and zero fixture residue all agree. | Deliberate removal of a critical idempotency, SHA, redaction, or ownership guard must fail its direct oracle before restoration. | Disposable PostgreSQL/Kafka/BuildKit/registry, real kind/Envoy Gateway, controlled GitHub fixture, browser only where existing M6 flow is needed. |

## Exit checklist

- [x] Check Run create/update/recovery is implemented with one stable identity per
      deployment and the smallest required GitHub App permission (`checks: write`).
- [x] Check Run state/conclusion mapping is covered by unit and controlled HTTP
      tests; terminal states do not regress after delayed delivery.
- [x] Preview URL generation is centralized, uses the configured base domain,
      matches the Gateway host, and is emitted only after durable `READY`.
- [x] Pull-request close consumes the existing deletion intent, settles its
      durable request, and safely handles duplicate delivery, worker restart,
      absent namespace, wrong owner, and reopen races.
- [x] TTL assignment, refresh, expiry sweep, and cleanup reason are durable,
      bounded, and idempotent.
- [x] Orphan reconciliation deletes only a labeled, UUID-identified,
      ownership-verified orphan and leaves unsafe candidates untouched.
- [x] No platform/GitHub/database/Kubernetes credential enters a build context,
      image layer, Kafka payload, API response, Check Run output, or log.
- [x] `pnpm check`, `pnpm docs:check`, and `git diff --check` pass after final
      integration; real PostgreSQL/Kafka/kind/Gateway acceptance is recorded.
- [x] Final report, backlog archive, roadmap status, and project knowledge index
      agree; any VictusOS sync is recorded only after the canonical project
      report exists.

## Planning handoff

```yaml
id: M7-PLAN
status: complete
acceptance_ref: docs/plans/m7-github-feedback-cleanup.md#M7-PLAN
owned_paths: [docs/plans/m7-github-feedback-cleanup.md, docs/backlog/active.md, docs/backlog/archive.md, docs/knowledge/previewforge-memory.md]
verification_command: pnpm docs:check; git diff --check
next_action: none; M7 integrated acceptance is complete and M8 is the next roadmap milestone.
blocker: none
acceptance: M7 scope, dependencies, ownership ledger, runtime acceptance rows, security boundaries, and exit checklist are recorded before product edits.
evidence: pnpm docs:check and git diff --check after the planning files are written.
evidence_commit: not-run; this gate records the contract, not product implementation evidence.
```
