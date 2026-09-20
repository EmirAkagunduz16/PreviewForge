# M9 execution plan — local product experience

Status: active — the disposable PostgreSQL/Kafka/registry gate and full root integration now pass on override ports; host M4 rootless prerequisites are provisioned, while the pinned binary/staging and M9-LOCAL-RUNTIME supervisor drill remain pending; M9-ONBOARDING implementation checkpoint is complete and its direct acceptance is pending; M9-LOCAL-ROUTING is awaiting real routing proof; M9-LOCAL-DEMO fixture implementation checkpoint is complete and its direct acceptance is pending
Owner: PreviewForge delivery
Roadmap: [M9 — Local product experience](../delivery/roadmap.md#M9--local-product-experience-active)
Baseline before planning: HEAD f112b1a7030f19a686f9c4238c11498b6b4b43e1; tree b7c4ef883520131b9463d79594226310b29853d4. The pre-existing M8 closure documentation changes and protected untracked `.codex/` path remain outside M9 implementation ownership.
Sources: [AGENTS.md](../../AGENTS.md), [Codex çalışma protokolü](../process/codex-calisma-protokolu.md), [MVP scope](../product/mvp-scope.md), [system design](../architecture/system-design.md), [deployment state machine](../architecture/deployment-state-machine.md), [ADR 0003](../architecture/decisions/0003-gateway-api.md), [ADR 0004](../architecture/decisions/0004-rootless-buildkit.md), [threat model](../security/threat-model.md), [delivery skill](../../.agents/skills/previewforge-delivery/SKILL.md), [milestone orchestrator skill](../../.agents/skills/previewforge-milestone-orchestrator/SKILL.md), [control-plane skill](../../.agents/skills/previewforge-control-plane/SKILL.md), and [Kubernetes skill](../../.agents/skills/previewforge-kubernetes/SKILL.md).
Planning gate: M9-PLAN is complete when this contract, ownership ledger, acceptance matrix, exit checklist, active backlog, roadmap, and README agree and `pnpm docs:check` plus `git diff --check` pass. Product implementation has completed the M9-ONBOARDING and M9-LOCAL-DEMO fixture checkpoints; disposable dependency/integration evidence is fresh, while M9-LOCAL-RUNTIME, M9-ONBOARDING, M9-LOCAL-ROUTING, and M9-LOCAL-DEMO direct acceptance remain pending.

## Outcome

M9 turns the verified M0-M8 engineering system into a locally usable product.
A developer with the documented prerequisites can start the complete local
stack, sign in, install the GitHub App, select and import a repository, open a
pull request, follow the deployment in the dashboard, click a working local
preview URL, and observe ownership-safe cleanup after closing the pull request.

The primary success path is local and reproducible. A controlled GitHub HTTP
fixture provides deterministic acceptance without real credentials; a separate
operator guide explains the real GitHub App and webhook-tunnel setup. Neither
path weakens raw-body HMAC verification, installation ownership, desired-SHA
fencing, rootless builds, immutable digests, or Kubernetes workload policy.

## Scope boundary

Included:

- one foreground command that preflights and starts the owned local runtime;
- explicit status and ownership-safe teardown commands;
- database migration, PostgreSQL, Kafka, registry, rootless BuildKit, kind,
  Envoy Gateway, API, worker, and web readiness orchestration;
- GitHub sign-in, installation discovery, repository selection, project
  import, and actionable empty/error states in the dashboard;
- clickable local preview URLs that preserve the HTTPRoute hostname while
  targeting the configured loopback Gateway port;
- deterministic browser acceptance against controlled GitHub fixtures and
  real disposable PostgreSQL/Kafka/BuildKit/registry/kind/Envoy boundaries;
- a documented real-GitHub setup path with explicit callback and webhook
  reachability checks.

Excluded:

- production deployment, EKS/ECR, paid cloud resources, custom domains, TLS
  automation, public onboarding, team billing/RBAC, GitLab/Bitbucket,
  multi-container applications, persistent workload storage, and hostile
  multi-tenant execution;
- installing or silently reconfiguring system-wide Docker, kubectl, kind,
  RootlessKit, BuildKit, DNS, firewall, AppArmor, or tunnel software;
- storing real GitHub credentials in fixtures, generated files, logs, or
  repository history.

The previously named M9 cloud demo is re-sequenced as M10-CLOUD-DEMO. It stays
blocked by the existing cost boundary and is not an M9 dependency.

## Locked product and operating decisions

- `pnpm local:up` is the primary foreground operator command. It fails closed
  on a missing prerequisite, performs idempotent migrations/bootstrap, starts
  only PreviewForge-owned processes, prints safe readiness endpoints, and
  stays attached so failures remain visible.
- `pnpm local:status` is read-only and reports each required boundary without
  exposing configuration values. `pnpm local:down` stops only resources proven
  to be owned by this repository; it never deletes an unknown cluster,
  namespace, container, process, volume, or socket.
- The runtime may stage checksum-pinned local BuildKit/RootlessKit artifacts in
  an owned disposable directory, but it may not mount the Docker socket into a
  build, use privileged mode, disable AppArmor globally, change the global
  user-namespace sysctl, or use host networking.
- Real GitHub webhooks require an explicitly configured public HTTPS tunnel.
  The repository documents this requirement and validates the configured
  callback/setup/webhook URLs; it does not create an external account or
  tunnel without the user's action.
- The dashboard discovers installations for the authenticated owner. Users do
  not copy installation IDs or call import APIs manually.
- The import form exposes only the supported v1 inputs: repository,
  Dockerfile path, container port, and health path. Boundary validation remains
  in the API even when the browser validates first.
- Empty project state, authentication required, API unavailable, GitHub setup
  incomplete, permission denied, and import validation failure are distinct
  observable states with a safe retry or next action.
- Local preview URLs use the existing hostname identity and an explicit
  optional local port. For example, the browser receives
  `http://preview-<environment-id>.preview.localhost:18080/`; production URL
  rules remain HTTPS and portless unless separately designed.
- PostgreSQL remains the source of truth and Kafka remains at-least-once
  transport. M9 adds no alternate local-only workflow authority.

## Baseline and sequential ownership ledger

~~~yaml
baseline_commit: f112b1a7030f19a686f9c4238c11498b6b4b43e1
baseline_tree: b7c4ef883520131b9463d79594226310b29853d4
staged_paths: []
protected_preexisting_modified:
  - README.md
  - docs/backlog/active.md
  - docs/backlog/archive.md
  - docs/delivery/roadmap.md
  - docs/knowledge/previewforge-memory.md
  - docs/plans/m8-hardening-cloud-demo.md
  - docs/reports/index.md
protected_preexisting_untracked:
  - .codex/
  - docs/reports/session-2026-09-18-m8-local-gate.md
protected_paths:
  - .git/
  - .agents/
  - .env
  - .env.local
agent_policy: root owns shared files, integration, runtime identity, backlog/reporting, and final evidence; slices run sequentially unless an explicit collision-free ownership packet is recorded
~~~

~~~yaml
root_owned:
  - package.json
  - pnpm-lock.yaml
  - .env.example
  - README.md
  - docs/plans/m9-local-product-experience.md
  - docs/backlog/active.md
  - docs/backlog/archive.md
  - docs/delivery/roadmap.md
  - docs/reports/
  - docs/knowledge/previewforge-memory.md
  - final milestone wiring and acceptance evidence

M9-LOCAL-RUNTIME:
  depends_on: [M9-PLAN]
  owned:
    - scripts/local/
    - scripts/local-infra.mjs
    - scripts/kubernetes/
    - infrastructure/local/compose.yaml
    - docs/operations/local-development.md

M9-ONBOARDING:
  depends_on: [M9-PLAN]
  owned:
    - apps/web/app/
    - apps/api/src/auth/auth.service.ts
    - apps/api/src/auth/auth.types.ts
    - apps/api/src/api-exception.filter.ts
    - apps/api/src/installations/
    - apps/api/src/projects/
    - packages/database/src/auth-installation-repository.ts
    - packages/database/src/project-repository.ts
    - packages/contracts/src/github.ts

M9-LOCAL-ROUTING:
  depends_on: [M9-PLAN]
  owned:
    - packages/contracts/src/preview-url.ts
    - packages/contracts/test/preview-url.test.ts
    - apps/worker/src/preview-url.ts
    - apps/worker/src/preview-url.test.ts
    - apps/worker/src/github-checks/
    - apps/api/src/app.module.ts
    - apps/api/src/dashboard/dashboard.service.ts
    - apps/api/src/dashboard/dashboard.service.test.ts
    - apps/web/app/page.tsx
    - docs/infrastructure/m5-kubernetes.md

M9-LOCAL-DEMO:
  depends_on: [M9-LOCAL-RUNTIME, M9-ONBOARDING, M9-LOCAL-ROUTING]
  owned:
    - fixtures/m9/
    - scripts/m9/
    - docs/operations/local-github-app.md

M9-ACCEPTANCE:
  depends_on: [M9-LOCAL-DEMO]
  owned:
    - docs/reports/session-YYYY-MM-DD-m9-local-product.md
    - docs/reports/index.md
    - docs/backlog/active.md
    - docs/backlog/archive.md
    - docs/delivery/roadmap.md
    - docs/knowledge/previewforge-memory.md
    - README.md
~~~

No slice may edit another slice's owned path. Shared manifests, environment
examples, reports, backlog, roadmap, and final wiring remain root-owned unless
the ledger is updated first. Any implementation agent must stop when work
requires an unowned path, real secret, shared/production target, system-wide
configuration change, or broader security permission.

## Slice contracts

### M9-PLAN

- Status: complete for this planning step on 2026-09-18.
- Objective: define the local-product boundary, locked UX/runtime decisions,
  dependency order, ownership ledger, real acceptance matrix, and exit gate.
- Acceptance: this plan exists; unfinished M9 slices and blocked M10 cloud work
  are in active backlog; roadmap and README select M9 as the sole active
  milestone; M9-PLAN is archived without claiming implementation.
- Verification: `pnpm docs:check`; `git diff --check`.

### M9-LOCAL-RUNTIME

- Objective: provide one observable, ownership-safe way to start, inspect, and
  stop the complete local PreviewForge runtime.
- Required behavior: preflight exact tools/context; start or reuse owned
  PostgreSQL/Kafka/registry; apply migrations; create/reuse the named kind
  cluster and Gateway; connect the registry; start a dedicated rootless
  BuildKit socket when a pre-provisioned managed command is configured, or
  verify the accepted socket boundary; start API/worker/web; wait for
  readiness; print endpoints; propagate process failure; and clean only exact
  owned resources on down.
- Acceptance: from the documented prerequisite baseline, `pnpm local:up`
  reaches ready without manual hidden steps, `pnpm local:status` identifies all
  boundaries, a second start is idempotent, and `pnpm local:down` leaves no M9
  process/socket/temporary resource residue while preserving unrelated state.
- Verification: focused script tests plus a real disposable runtime drill.

### M9-ONBOARDING

- Objective: complete the browser path from sign-in to an imported project.
- Required behavior: show distinct unauthenticated/offline/empty/setup/error
  states; link installation start; list owner-linked installations and
  accessible repositories; collect supported import settings; submit import;
  display validation/permission errors safely; and transition to the project
  dashboard without a manual refresh or copied ID.
- Acceptance: browser acceptance proves sign-in, installation callback,
  repository discovery, successful import, duplicate import behavior,
  inaccessible repository rejection, safe errors, and owner isolation against
  a controlled GitHub fixture and real PostgreSQL.
- Verification: focused web/API tests, direct HTTP integration, and browser
  acceptance. UI-only mocks are insufficient.

### M9-LOCAL-ROUTING

- Status: implementation checkpoint complete; real kind/Envoy/browser acceptance
  remains pending on the local runtime prerequisites.
- Objective: make the READY preview URL directly clickable in the local
  browser topology without changing Gateway ownership or production rules.
- Required behavior: support an optional validated local preview port, retain
  the environment-derived hostname used by HTTPRoute, reject credentials or
  malformed authority input, and use the same URL in API/dashboard/GitHub
  Check output.
- Acceptance: a real restricted workload becomes READY by immutable digest;
  clicking its emitted `preview.localhost:<port>` URL returns the fixture
  response through Envoy; a wrong hostname returns the negative routing result;
  production configuration still rejects local HTTP domains.
- Verification: shared-contract, worker Check, API dashboard, and web build
  checks passed; real kind/Envoy and browser evidence is still required.

### M9-LOCAL-DEMO

- Status: fixture implementation checkpoint complete; full browser/runtime
  acceptance remains blocked by the local dependency gate.
- Objective: prove the complete user journey with deterministic local inputs
  and document the separate real-GitHub configuration path.
- Required behavior: controlled GitHub OAuth/App/repository/webhook/Check Run
  fixture; one Dockerfile HTTP application; open, synchronize, failure/retry,
  READY, live logs, preview navigation, and close cleanup; no real credential
  requirement; exact fixture and residue ownership.
- Acceptance: a fresh local run completes the journey through the browser and
  externally observable boundaries; duplicate/reordered webhook delivery is
  harmless; a newer SHA supersedes stale work; secret-shaped values are absent
  from UI/logs/telemetry; close removes the owned namespace; rerun succeeds.
- Verification: fixture manifest/credential scan, loopback GitHub endpoint
  smoke checks, and signed webhook runner syntax passed; direct M9 acceptance
  against real disposable local dependencies remains required.

### M9-ACCEPTANCE

- Objective: close M9 only after implementation, clean review, real runtime
  proof, failure sensitivity, documentation agreement, and zero residue.
- Acceptance: every exit item is checked; critical acceptance rows include an
  executed broken-case/fault result and restoration; `pnpm check`, direct M9
  acceptance, `pnpm docs:check`, and `git diff --check` pass after final edits;
  completed slices are archived and no M9 item remains active.
- Verification: root-run final proof packet and canonical session report.

### M10-CLOUD-DEMO (deferred)

- Status: blocked; it is not an M9 dependency.
- Unblock condition: explicit maximum spend, billing alert, disposable AWS
  account/region, resource lifetime, and destroy procedure approval.
- No AWS credential, account preflight, EKS/ECR mutation, or cloud acceptance
  is authorized by this plan.

## Acceptance matrix

| Slice | Risk | Stimulus | Oracle | Fault sensitivity | Runtime |
|---|---|---|---|---|---|
| M9-LOCAL-RUNTIME | The documented command starts only part of the stack, hides a failed process, or deletes unrelated local resources. | Start from stopped owned services, run up twice, terminate one child, inspect status, then run down with unrelated Docker/kind resources present. | Every required readiness probe becomes healthy; child failure is surfaced; exact owned identities disappear after down and unrelated identities remain. | Disable one readiness/ownership guard and show the drill fails before restoring it. | Docker Compose, PostgreSQL, Kafka, registry, rootless BuildKit, kind, Envoy, API, worker, web. |
| M9-ONBOARDING | An authenticated user cannot install/import without manual API calls, sees misleading empty state, crosses owner boundaries, or leaks an upstream error/token. | Exercise unauthenticated, API-offline, no-installation, inaccessible repository, duplicate import, malformed settings, successful import, and foreign-owner cases. | Browser presents the correct action/state; PostgreSQL contains exactly the authorized installation/project; responses and DOM contain no secret or foreign project. | Remove an ownership check or map API-offline to empty and show the direct/browser assertion fails, then restore. | Browser, web, API, PostgreSQL, controlled GitHub HTTP fixture. |
| M9-LOCAL-ROUTING | A reported READY URL is not clickable locally, routes to the wrong preview, or weakens production URL validation. | Deploy two hostname-distinct fixtures, navigate to the emitted local URL with configured port, try wrong Host, malformed port, and production-local-domain config. | Correct URL returns the expected fixture through Envoy; wrong host does not; Check/dashboard URLs match; invalid configs fail closed. | Remove hostname or port propagation and show the browser/routing assertion fails before restoration. | Worker, registry, real kind cluster, Envoy Gateway, browser. |
| M9-LOCAL-DEMO | Individual components pass while the real user lifecycle, stale-SHA guard, retry, redaction, or cleanup is broken. | Drive sign-in/install/import, duplicate open, synchronize during work, injected retryable and terminal failure, READY navigation, log reconnect, and repeated close. | Durable state/event counts, UI stages/logs, immutable digest, GitHub Check fixture, routed response, and final DB/Kafka/Kubernetes/process residue all match the contract. | Disable one dedupe/desired-SHA/cleanup/redaction guard per critical class and record the acceptance failure before restoration. | Controlled GitHub fixture, browser, PostgreSQL, Kafka, rootless BuildKit, registry, kind, Envoy, API, worker, web. |
| M9-ACCEPTANCE | M9 is declared complete from stale or partial evidence. | Re-run the direct acceptance and repository gates after the last implementation/document edit, then inspect exact residue and changed paths. | Final report contains runtime identity, commands, expected/observed counts, adversarial result, changed files, teardown, and no active M9 entries. | Invalidate one required proof source and keep closure blocked until it is rerun. | Final repository tree and the complete disposable local runtime. |

## Delivery waves

1. **Wave 0 — M9-PLAN:** archive only the planning gate after docs checks.
2. **Wave 1 — foundations:** implement M9-LOCAL-RUNTIME,
   M9-ONBOARDING, and M9-LOCAL-ROUTING in collision-free ownership lanes or
   sequentially where shared files are needed.
3. **Wave 2 — M9-LOCAL-DEMO:** integrate the three foundations into one
   deterministic browser/runtime journey.
4. **Wave 3 — M9-ACCEPTANCE:** run the full proof packet, second review,
   residue inspection, reporting, and backlog/archive closure.

## Exit checklist

- [ ] `pnpm local:up`, `pnpm local:status`, and `pnpm local:down` satisfy the
      ownership, readiness, repeatability, and residue contract.
- [ ] A user completes GitHub sign-in, installation, repository selection, and
      project import from the dashboard without copied internal identifiers.
- [ ] Offline, unauthenticated, empty, setup-required, permission, validation,
      and runtime-failure states are distinct and actionable.
- [ ] The emitted local preview URL is clickable and routes through real
      Envoy to the correct restricted workload by immutable digest.
- [ ] The controlled end-to-end flow covers open, duplicate, synchronize,
      failure/retry, READY, logs, preview navigation, and repeated close.
- [ ] Owner isolation, raw webhook verification, desired-SHA fencing,
      write-only secrets, redaction, rootless build, restricted workload, and
      ownership-safe cleanup remain intact.
- [ ] Critical rows have executed fault-sensitivity evidence and restored tree
      proof; no required runtime check is silently skipped.
- [ ] Final PostgreSQL fixture rows, Kafka groups/events, registry artifacts,
      managed namespaces, processes, sockets, and temporary credentials are
      zero/absent according to the exact ownership ledger.
- [ ] Real GitHub App setup and public webhook-tunnel requirements are
      documented without committing credentials or auto-creating accounts.
- [ ] `pnpm check`, direct M9 acceptance, `pnpm docs:check`, and
      `git diff --check` pass after the final change set.
- [ ] Final report, roadmap, README, plan, backlog/archive, and project memory
      agree; M10-CLOUD-DEMO remains separately blocked with no AWS action.

## Planning handoff

~~~yaml
id: M9-PLAN
status: complete
acceptance_ref: docs/plans/m9-local-product-experience.md#M9-PLAN
owned_paths: [docs/plans/m9-local-product-experience.md, docs/backlog/active.md, docs/backlog/archive.md, docs/delivery/roadmap.md, docs/knowledge/previewforge-memory.md, README.md]
verification_command: pnpm docs:check; git diff --check
next_action: restore the accepted local runtime prerequisites, then run direct M9-ONBOARDING and M9-LOCAL-ROUTING acceptance while preserving pre-existing M8 closure changes
blocker: none for M9 planning; M10-CLOUD-DEMO remains blocked by the explicit AWS cost boundary
acceptance: the local-product execution contract, unfinished slices, runtime acceptance matrix, ownership ledger, and deferred cloud boundary are recorded without claiming implementation
evidence: planning-gate commands after the plan, roadmap, backlog, README, and project-memory update
evidence_commit: not-run
~~~
