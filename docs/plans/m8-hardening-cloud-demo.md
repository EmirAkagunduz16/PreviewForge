# M8 execution plan — hardening and cloud demo

Status: active
Owner: PreviewForge delivery
Roadmap: [M8 — Hardening and cloud demo](../delivery/roadmap.md#M8--hardening-and-cloud-demo-active--week-8)
Baseline before planning: HEAD 012e28f36058546cc1df7e785797fe8e80e1a634; tree 3c7ecc51e6b31eaa378f6cf4d038c45499f8db27. The protected untracked .codex/ directory is not part of this milestone.
Sources: [MVP scope](../product/mvp-scope.md), [system design](../architecture/system-design.md), [deployment state machine](../architecture/deployment-state-machine.md), [ADR 0001](../architecture/decisions/0001-modular-control-plane.md), [ADR 0002](../architecture/decisions/0002-postgres-outbox-and-kafka.md), [ADR 0003](../architecture/decisions/0003-gateway-api.md), [ADR 0004](../architecture/decisions/0004-rootless-buildkit.md), [ADR 0005](../architecture/decisions/0005-sse-for-live-output.md), [threat model](../security/threat-model.md), [project memory](../knowledge/previewforge-memory.md), [M7 execution plan](m7-github-feedback-cleanup.md), [M7 integrated acceptance](../reports/session-2026-09-17-m7-acceptance.md), [delivery skill](../../.agents/skills/previewforge-delivery/SKILL.md), [milestone orchestrator skill](../../.agents/skills/previewforge-milestone-orchestrator/SKILL.md), [control-plane skill](../../.agents/skills/previewforge-control-plane/SKILL.md), and [Kubernetes skill](../../.agents/skills/previewforge-kubernetes/SKILL.md).
Planning gate: M8-PLAN is complete when this contract, the ownership ledger, the local-before-cloud dependency, the acceptance matrix, and the exit checklist are recorded. Product implementation begins with M8-FIXTURES.

## Outcome

M8 hardens the already-complete M0-M7 MVP and produces one reproducible cloud
demonstration. The milestone must prove the complete local lifecycle against
real disposable dependencies, exercise failure windows instead of only happy
paths, expose useful low-cardinality metrics and correlated traces, provide
operator dashboards and backup/restore guidance, and then repeat the essential
demo flow on one disposable AWS EKS/ECR environment.

The final demo covers:

1. pull-request open creates a deployment for the exact commit;
2. synchronize supersedes stale work without publishing the old result;
3. build, rollout, health-check, GitHub feedback, and retry failures remain
   durable, redacted, and correctly classified;
4. a successful immutable image reaches READY and the routed preview responds;
5. pull-request close removes the owned preview safely; and
6. the local and cloud runs leave no disposable database, Kafka, registry,
   Kubernetes, process, or temporary credential residue.

M8 does not expand the MVP into production deployments, multi-cloud or
multi-region operation, arbitrary manifests, team RBAC, public hostile
multi-tenancy, Redis, managed database/Kafka provisioning, or a production
RPO/RTO/SLO commitment.

## Locked boundary and operating decisions

- PostgreSQL remains the authoritative workflow and backup source. Kafka stays
  at-least-once transport behind the transactional outbox; Kafka offsets are
  never the only record of intent. Restore notes must explain topic recreation
  and outbox replay rather than presenting Kafka as a second source of truth.
- The API remains one modular NestJS process and the worker remains the one
  independently scalable deployment process. Prometheus, Grafana, an
  OpenTelemetry collector, and a trace backend may run as disposable
  observability infrastructure, but they are not new PreviewForge control-plane
  services and do not own product state.
- Local acceptance is a hard gate. No AWS resource, ECR push, or cloud
  credential setup is attempted until M8-LOCAL-ACCEPTANCE has passed with
  clean residue checks.
- Failure injection is test-only and deterministic. Faults are introduced
  through adapter seams, controlled fixtures, or a test process termination;
  there is no production environment variable that lets a user request a
  crash or bypass an invariant.
- Metrics use bounded labels only: method, stable route family, HTTP status,
  stage, outcome, retry class, topic, consumer, and error code. Commit SHAs,
  repository names, environment IDs, deployment IDs, payloads, tokens,
  environment-variable values, and raw upstream bodies are not metric labels
  or log fields. Traces may carry safe internal correlation IDs, but never
  secrets or unbounded payloads.
- The telemetry contract covers webhook intake, outbox publication, Kafka
  consumption/lag, deployment stage duration, build and rollout outcomes,
  GitHub feedback, cleanup, API errors, and worker health. Trace context must
  survive the HTTP-to-outbox-to-Kafka-to-worker boundary.
- Dashboards are provisioned as code and must render data from a real local
  acceptance run. At minimum they show lifecycle throughput/failures,
  outbox/Kafka backlog, build/deploy latency, retry/dead-letter activity,
  cleanup/orphan activity, and API/worker health.
- Backup/restore notes cover PostgreSQL backup and restore into an isolated
  disposable database, schema migration verification, Kafka topic/config
  recreation, outbox replay, and immutable registry artifact retention.
  Kubernetes resources are treated as reproducible derived state, not as the
  primary backup. The drill is a demo resilience proof, not a production
  disaster-recovery claim.
- The cloud demo is one disposable AWS account/region environment. It uses
  user-provided AWS authority and pre-provisioned demo PostgreSQL, Kafka, and
  rootless BuildKit endpoints; M8 does not silently add RDS, MSK, or another
  managed service. If those endpoints or the required AWS permissions are not
  available, M8-CLOUD-DEMO remains blocked with the exact smallest unblock
  action.
- Cloud images are pushed to ECR and deployed by immutable digest. The EKS
  worker identity is least-privilege and its negative RBAC checks are
  exercised. Preview workloads retain disabled service-account token
  automounting, restricted security contexts, resource limits, and the
  default-deny/explicit-allow network policy model.
- EKS acceptance requires actual NetworkPolicy enforcement by the selected
  CNI, not only an admitted manifest. A preview-to-database/Kafka/metadata
  probe must be denied while the intended DNS/Gateway path remains usable. If
  the selected CNI cannot enforce this, the cloud slice is blocked rather than
  recorded as passed.

## Baseline and sequential ownership ledger

The planning baseline was clean except for the protected untracked .codex/
directory:

~~~yaml
baseline_commit: 012e28f36058546cc1df7e785797fe8e80e1a634
baseline_tree: 3c7ecc51e6b31eaa378f6cf4d038c45499f8db27
staged_paths: []
unstaged_paths: []
protected_untracked:
  - .codex/
protected_paths:
  - .git/
  - .agents/
  - .env
  - .env.local
agent_policy: root owns integration, runtime identity, final evidence, and shared files; implementation slices run sequentially unless an explicit exclusive ownership packet is issued
~~~

The slices are intentionally sequential so shared application wiring and
disposable runtime state cannot be edited or exercised concurrently:

~~~yaml
root_owned:
  - docs/plans/m8-hardening-cloud-demo.md
  - docs/backlog/active.md
  - docs/backlog/archive.md
  - docs/reports/
  - docs/knowledge/previewforge-memory.md
  - package.json
  - pnpm-lock.yaml
  - pnpm-workspace.yaml
  - .env.example
  - packages/database/prisma/schema.prisma
  - packages/database/prisma/migrations/
  - packages/database/src/index.ts
  - packages/contracts/src/index.ts
  - final milestone wiring and acceptance evidence

M8-FIXTURES:
  depends_on: [M8-PLAN]
  owned:
    - fixtures/m8/
    - scripts/m8/fixtures/
    - docs/operations/m8-backup-restore.md

M8-E2E-FAULTS:
  depends_on: [M8-FIXTURES]
  owned:
    - apps/api/src/m8.integration.test.ts
    - apps/worker/src/m8.acceptance.test.ts
    - apps/worker/src/m8-faults/
    - apps/api/src/test-support/m8/

M8-OBS:
  depends_on: [M8-E2E-FAULTS]
  owned:
    - packages/observability/
    - apps/api/src/observability/
    - apps/api/src/health.controller.ts
    - apps/api/src/main.ts
    - apps/api/src/application.ts
    - apps/worker/src/observability/
    - apps/worker/src/main.ts
    - apps/worker/src/config.ts
    - infrastructure/observability/
    - docs/operations/m8-observability.md

M8-LOCAL-ACCEPTANCE:
  depends_on: [M8-FIXTURES, M8-E2E-FAULTS, M8-OBS]
  owned:
    - scripts/m8/run-local-acceptance.mjs

M8-CLOUD-DEMO:
  depends_on: [M8-LOCAL-ACCEPTANCE]
  owned:
    - infrastructure/eks/
    - scripts/m8/cloud/
    - docs/infrastructure/m8-eks-ecr-demo.md
    - .github/workflows/m8-cloud-demo.yml

M8-ACCEPTANCE:
  depends_on: [M8-LOCAL-ACCEPTANCE, M8-CLOUD-DEMO]
  owned:
    - docs/reports/session-2026-09-17-m8-acceptance.md
    - docs/reports/index.md
    - docs/backlog/active.md
    - docs/backlog/archive.md
    - docs/knowledge/previewforge-memory.md
~~~

No slice may edit another slice's owned path. Shared package manifests,
workspace wiring, migrations, reports, backlog, and knowledge remain root-owned
unless the root explicitly updates this ledger first. A delegated agent must
stop if its acceptance requires an unowned path, a secret, a production/shared
runtime, or a broader security permission.

## Slice contracts

### M8-PLAN

- Status: complete for this planning step on 2026-09-17.
- Objective: record the hardening/cloud boundary, locked sequencing, ownership
  ledger, runtime acceptance matrix, and milestone exit criteria before product
  implementation changes.
- Acceptance: this plan exists; active backlog contains every unfinished M8
  slice; the planning item is archived with evidence; the roadmap and README
  still agree that M8 is the sole active milestone.
- Verification: pnpm docs:check and git diff --check.
- Evidence: the planning-gate commands run after this document and backlog
  update; no implementation behavior is claimed here.

### M8-FIXTURES

- Dependency: M8-PLAN and the complete M7 acceptance baseline.
- Objective: create deterministic, synthetic demo fixtures and the
  backup/restore runbook without placing credentials in the repository.
- Required behavior: a controlled GitHub HTTP fixture supports webhook,
  source, Check Run, duplicate, delayed, and lost-response cases; repository
  fixtures cover successful build, build failure, health failure, and
  retryable upstream failure; seed and teardown are repeatable and use
  PreviewForge ownership labels and bounded identities.
- Restore contract: dump PostgreSQL into an isolated database, apply the
  current migrations, restore a fixture checkpoint, verify authoritative
  deployment/environment/outbox state, recreate Kafka topics, and demonstrate
  that outbox replay re-establishes transport intent without duplicating
  domain state. Record registry digest retention and reproducible Kubernetes
  resource rendering.
- Acceptance: seeding twice produces stable, non-conflicting fixtures; the
  restore drill reaches the expected rows and event state; teardown leaves
  zero fixture rows, outbox rows, managed namespaces, registry artifacts
  intended only for the drill, and fixture processes.
- Fault sensitivity: inject a failure after the first restore/seed write and
  verify the cleanup or transaction path does not leave a partial fixture;
  remove ownership validation in a disposable copy and the cleanup oracle
  must fail.

### M8-E2E-FAULTS

- Dependency: M8-FIXTURES.
- Objective: prove the complete local lifecycle and the important crash/retry
  windows through the real API, worker, and infrastructure boundaries.
- Required workflow: open a pull request, synchronize with a newer SHA during
  build or rollout, observe the stale attempt become SUPERSEDED, force a
  source/build/health failure, retry with a new attempt, reach READY with an
  immutable digest and routed preview, then close and verify owned cleanup.
  Repeated webhook, outbox, Kafka, Check Run, and cleanup delivery must remain
  idempotent.
- Failure injection points: transaction failure before outbox commit; relay
  failure after publish before durable acknowledgement; worker termination
  after an external side effect before Kafka offset commit; lost GitHub Check
  Run create response; Kubernetes apply/rollout/health failure; and cleanup
  delete interruption. Each injection must assert durable state and the
  externally observable side effect after restart/retry.
- Acceptance: one logical workflow produces the expected PostgreSQL state,
  Kafka/outbox facts, Check Run observations, immutable image, Gateway HTTP
  result, and final namespace deletion, with bounded redaction and no secret
  in logs, payloads, build context, or preview resources.
- Fault sensitivity: temporarily remove the desired-SHA guard, durable
  delivery identity, or cleanup ownership check in a disposable mutation and
  require its targeted test to fail before restoring the correct tree.

### M8-OBS

- Dependency: M8-E2E-FAULTS; implementation uses the real lifecycle seams
  rather than creating an independent telemetry-only workflow.
- Objective: add safe metrics, distributed traces, and provisioned operator
  dashboards for the API and worker.
- Required behavior: expose internal Prometheus-compatible metrics for API and
  worker; emit OpenTelemetry-compatible spans for HTTP/webhook, database
  transaction boundaries, outbox/Kafka publish/consume, deployment stages,
  BuildKit, Kubernetes reconciliation, GitHub feedback, health checks, and
  cleanup; propagate trace context across Kafka headers; preserve existing
  JSON log redaction and request correlation.
- Dashboard contract: provision dashboards as code for lifecycle throughput and
  failures, outbox/Kafka lag, stage/build/rollout latency, retry/dead-letter
  activity, cleanup/orphan outcomes, and API/worker health. Missing telemetry
  backends or zero discovered panels is a failed acceptance, not a skip.
- Acceptance: one real local acceptance run yields scrapeable metric samples,
  linked HTTP-to-worker traces, and non-empty dashboard panels. No metric,
  span, dashboard, or log observation contains a credential, environment
  value, raw payload, or high-cardinality commit/repository identifier.
- Fault sensitivity: disable a required counter or Kafka trace-header
  propagation in a temporary mutation; the direct metric/trace oracle must
  fail before restoration.

### M8-LOCAL-ACCEPTANCE

- Dependency: M8-FIXTURES, M8-E2E-FAULTS, and M8-OBS.
- Objective: run the complete local M8 gate from a clean disposable runtime
  identity before authorizing any cloud mutation.
- Required command set: the new M8 local acceptance runner; each critical
  acceptance file directly with a non-zero test expectation; pnpm check;
  pnpm docs:check; and git diff --check. The evidence must include expected
  versus observed test files/cases, PostgreSQL database/schema, Kafka broker
  and consumer groups, Docker context, Kubernetes context/namespace, and
  telemetry backend identity.
- Acceptance: open, synchronize race, failure, retry, ready, close cleanup,
  failure injection, metrics/traces/dashboard observations, and the
  PostgreSQL restore drill pass against disposable PostgreSQL, Kafka,
  rootless BuildKit, registry, kind, Envoy Gateway, API, worker, and the
  controlled GitHub fixture. Final residue is zero or explicitly documented
  pre-existing infrastructure outside the run.
- Fault sensitivity: run the critical adversarial mutation from
  M8-E2E-FAULTS after final integration and prove the restored tree passes
  again. A mock-only or manifest-only result does not close this gate.

### M8-CLOUD-DEMO

- Dependency: M8-LOCAL-ACCEPTANCE is green and residue-free.
- Objective: deploy one disposable PreviewForge demo to AWS EKS with ECR as
  the immutable image registry, using only the approved demo authority.
- Required behavior: provision or select the explicitly named EKS cluster and
  namespace, install a conformant Gateway API controller, deploy API/worker
  and rootless BuildKit with redacted configuration, push the fixture image
  to ECR, resolve and deploy its digest, and connect the pre-provisioned demo
  PostgreSQL/Kafka endpoints. The deployment must expose no public database,
  Kafka, BuildKit socket, worker credential, or preview Pod service-account
  token.
- Security acceptance: worker IAM/RBAC can perform only the required
  operations; negative can-i checks reject unrelated namespaces, Secrets,
  Nodes, ClusterRoles, and arbitrary cluster mutation. Real CNI
  NetworkPolicy probes deny preview access to control-plane, metadata,
  database, Kafka, and registry-management endpoints while allowing the
  intended DNS/Gateway path. Preview resources carry owner/expiry labels,
  restricted security context, requests/limits, and automount disabled.
- Acceptance: after local success, the same fixture drives open,
  synchronize supersession, failure/retry, READY with ECR digest and routed
  HTTP response, and close cleanup on EKS. ECR, EKS, Gateway, PostgreSQL,
  Kafka, telemetry, and process residue are inspected and the destroy path is
  documented.
- Fault sensitivity: a disposable cloud check with the NetworkPolicy or
  worker RBAC guard deliberately absent must fail its direct probe; restore
  the guarded configuration before final evidence. No such mutation is made
  against a shared or production account.

### M8-ACCEPTANCE

- Dependency: M8-LOCAL-ACCEPTANCE and M8-CLOUD-DEMO.
- Objective: close M8 only after local hardening and the ordered cloud demo
  are independently evidenced.
- Acceptance: the final report records the exact commands, tree/commit,
  runtime identities, test discovery/counts, failure-injection outcomes,
  dashboard/trace observations, restore result, EKS/ECR security checks,
  changed-file set, teardown result, and any blocked/non-goal item. Active
  backlog contains no completed item; completed slices are archived with
  evidence; roadmap, README, plan, backlog, reports, and project memory
  agree on the final status.
- Required final verification: pnpm check, pnpm docs:check, git diff --check,
  the direct local acceptance command, the direct cloud smoke command, and a
  read-only residue/process inspection after teardown.

## Acceptance matrix

| Slice | Risk | Stimulus | Observable oracle | Fault sensitivity | Runtime |
|---|---|---|---|---|---|
| M8-FIXTURES | Fixtures are non-repeatable, leak synthetic secrets, or leave rows/resources that contaminate later evidence. | Seed twice, restore a PostgreSQL checkpoint into a fresh database, recreate Kafka topics, replay outbox intent, and tear down repeatedly. | Stable fixture identities; expected authoritative rows and outbox facts; no duplicate domain state; zero fixture rows, managed namespaces, disposable registry artifacts, and processes after teardown. | Fail after the first seed/restore write and remove ownership validation in a disposable copy; transaction/cleanup and wrong-owner tests fail. | Disposable PostgreSQL, Kafka, registry, kind, and fixture HTTP servers. |
| M8-E2E-FAULTS | A full lifecycle appears green while stale work publishes, duplicate delivery creates side effects, or a crash loses durable intent. | Drive open, synchronize race, failure, retry, ready, close, duplicate/reordered delivery, and each listed crash window. | PostgreSQL state, outbox/Kafka facts, Check Run result, immutable digest, Gateway HTTP response, and cleanup are consistent after restart; secrets stay absent. | Remove desired-SHA, durable idempotency, or ownership guard and the direct real-boundary test fails before restoration. | API, worker, disposable PostgreSQL/Kafka, rootless BuildKit, registry, kind/Envoy Gateway, controlled GitHub fixture. |
| M8-OBS | Operators cannot see queue pressure/failure or traces cross the async boundary, or telemetry leaks sensitive/high-cardinality data. | Run the real lifecycle and injected failures; scrape metrics, query traces, and load provisioned dashboards. | Expected bounded-label samples, linked HTTP-to-worker spans, non-empty dashboard panels, redacted logs, and no raw payload/secret/high-cardinality labels. | Remove a required counter or Kafka trace propagation and the direct metric/trace oracle fails. | API/worker, Prometheus-compatible scraper, OpenTelemetry collector, trace backend, Grafana dashboards. |
| M8-LOCAL-ACCEPTANCE | Unit or fake-fixture success hides a broken integrated lifecycle, restore path, observability path, or residue leak. | Run the complete local command sequence twice where applicable from disposable runtime identities, then inspect state and processes. | All required scenarios pass with recorded discovery/counts, restore is usable, dashboards contain real data, and residue is zero or pre-existing and explained. | Re-run the targeted adversarial mutation after integration; the restored correct tree passes and the mutation fails. | Real local PostgreSQL/Kafka/BuildKit/registry/kind/Envoy/API/worker plus telemetry and controlled GitHub fixture. |
| M8-CLOUD-DEMO | Cloud IAM/RBAC or CNI is too broad/unenforced, an ECR tag is mutable, or the cloud demo passes only because local state is reused. | After local gate, deploy to one disposable EKS/ECR environment and drive the same fixture scenarios. | ECR digest is deployed; Gateway returns the expected response; negative RBAC checks deny; real CNI probes block forbidden paths; close removes owned preview; telemetry and teardown are observed. | Remove NetworkPolicy or worker RBAC guard in a disposable cloud check and its direct probe fails. | One authorized AWS account/region, EKS, ECR, conformant Gateway controller, real CNI, pre-provisioned PostgreSQL/Kafka/BuildKit, API, worker. |
| M8-ACCEPTANCE | Delivery is declared complete without fresh evidence, cloud ordering, or a clean handoff. | Review the final report, changed files, backlog/archive state, runtime residue, and all critical commands after the last edit. | Final report and project docs agree; exact evidence is reproducible; no completed item remains active; no unverified claim is labeled passed. | Delete or invalidate one final evidence source and the closure checklist remains incomplete until rerun. | Repository, local runtime, cloud demo runtime, and read-only residue inspection. |

## Exit checklist

- [ ] M8-FIXTURES is repeatable, synthetic, ownership-safe, and its PostgreSQL
      restore/outbox replay drill is recorded.
- [ ] M8-E2E-FAULTS proves open, synchronize supersession, failure, retry,
      READY, close cleanup, duplicate delivery, and crash-window recovery on
      real local dependencies.
- [ ] M8-OBS exposes safe metrics, correlated traces across Kafka, and
      provisioned dashboards populated by a real acceptance run.
- [ ] M8-LOCAL-ACCEPTANCE passes after the final implementation changes with
      direct test discovery/counts, fault-sensitivity evidence, and zero
      disposable residue.
- [ ] No AWS mutation occurs before the local gate is green and recorded.
- [ ] M8-CLOUD-DEMO runs on one disposable EKS/ECR environment with immutable
      digest deployment, least-privilege worker RBAC/IAM, Gateway routing,
      actual CNI policy enforcement, telemetry, and cleanup evidence.
- [ ] No platform, GitHub, registry, database, Kafka, or Kubernetes credential
      enters a build context, image layer, event payload, API response, log,
      metric label, trace attribute, or preview Pod.
- [ ] No production/shared target is used for destructive, concurrency,
      restore, or fault-injection tests.
- [ ] Final report, active/archive backlog, roadmap, README, plan, reports
      index, and project knowledge agree; any VictusOS sync is pending until
      the canonical project report exists.
- [ ] pnpm check, pnpm docs:check, git diff --check, direct local acceptance,
      direct cloud smoke, and post-teardown residue inspection pass after the
      final change set.

## Planning handoff

~~~yaml
id: M8-PLAN
status: complete
acceptance_ref: docs/plans/m8-hardening-cloud-demo.md#M8-PLAN
owned_paths: [docs/plans/m8-hardening-cloud-demo.md, docs/backlog/active.md, docs/backlog/archive.md]
verification_command: pnpm docs:check; git diff --check
next_action: implement M8-FIXTURES in its exclusive paths, beginning with deterministic fixtures and the isolated PostgreSQL restore drill
blocker: none for the planning gate; M8-CLOUD-DEMO later requires explicit disposable AWS authority and pre-provisioned demo PostgreSQL/Kafka/BuildKit endpoints
acceptance: the M8 execution contract and every unfinished slice are recorded without claiming product implementation
evidence: planning-gate commands after the document/backlog update
evidence_commit: not-run until root commit
~~~
