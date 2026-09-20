# Active backlog

M8 local hardening is complete. M9 local product experience is active under
the [M9 execution plan](../plans/m9-local-product-experience.md). Its planning
gate is archived; every unfinished implementation and acceptance slice remains
below. AWS/EKS/ECR is re-sequenced as blocked M10 work and is not an M9
dependency.

~~~yaml
- id: M9-LOCAL-RUNTIME
  status: in-progress
  title: Start, inspect, and stop the complete owned local runtime
  owner: PreviewForge delivery
  depends_on: [M9-PLAN]
  acceptance_ref: docs/plans/m9-local-product-experience.md#M9-LOCAL-RUNTIME
  owned_paths: [scripts/local/, scripts/local-infra.mjs, scripts/kubernetes/, infrastructure/local/compose.yaml, docs/operations/local-development.md]
  verification_command: focused script tests; pnpm local:up; pnpm local:status; repeated pnpm local:up; pnpm local:down; exact residue inspection
  next_action: restage the accepted rootless BuildKit config with the kind bridge registry endpoint, restart the dedicated stack, then run local:up/status/repeated-start/local:down with exact process/socket/container/cluster residue inspection
  blocker: the accepted BuildKit socket is live, but its daemon config currently permits only the rootless loopback registry; the M9 Compose registry endpoint needs to be staged as a plain-HTTP registry host before the real worker push and routing gate can pass
  acceptance: the documented command reaches ready without hidden steps, exposes child failures, is idempotent, and tears down only exact PreviewForge-owned resources with zero M9 process/socket/temp residue
  evidence: supervisor tests pass; disposable PostgreSQL/Kafka/registry stack, migrations, full root integration, browser onboarding, and fixture webhook checks pass; host M4 rootless provisioning and worker evidence pass, while the BuildKit-to-Compose-registry endpoint and complete runtime/routing drill remain unclaimed
  evidence_commit: not-run

- id: M9-ONBOARDING
  status: in-progress
  title: Complete browser GitHub installation and repository import
  owner: PreviewForge delivery
  depends_on: [M9-PLAN]
  acceptance_ref: docs/plans/m9-local-product-experience.md#M9-ONBOARDING
  owned_paths: [apps/web/app/, apps/api/src/auth/auth.service.ts, apps/api/src/auth/auth.types.ts, apps/api/src/api-exception.filter.ts, apps/api/src/installations/, apps/api/src/projects/, packages/database/src/auth-installation-repository.ts, packages/database/src/project-repository.ts, packages/contracts/src/github.ts]
  verification_command: focused web/API tests; direct HTTP/PostgreSQL integration; controlled-GitHub browser acceptance
  next_action: retain the passing controlled-GitHub browser evidence while the runtime registry endpoint gate is rerun
  blocker: real acceptance needs PostgreSQL plus the controlled GitHub fixture/browser path; no completion claim from unit/build checks alone
  acceptance: an authenticated owner installs or selects the GitHub App, discovers and imports an authorized repository without copied IDs, sees actionable safe errors, and cannot observe another owner's installation or project
  evidence: owner-scoped installation endpoint, safe import error codes, install CTA, repository picker, import form, and distinct auth/offline/setup/permission/validation UI implemented; focused API/web tests, full pnpm check, and builds pass; controlled browser acceptance remains pending
  evidence_commit: not-run

- id: M9-LOCAL-ROUTING
  status: in-progress
  title: Emit clickable local preview URLs through Envoy Gateway
  owner: PreviewForge delivery
  depends_on: [M9-PLAN]
  acceptance_ref: docs/plans/m9-local-product-experience.md#M9-LOCAL-ROUTING
  owned_paths: [packages/contracts/src/preview-url.ts, packages/contracts/test/preview-url.test.ts, apps/worker/src/preview-url.ts, apps/worker/src/preview-url.test.ts, apps/worker/src/github-checks/, apps/api/src/app.module.ts, apps/api/src/dashboard/dashboard.service.ts, apps/api/src/dashboard/dashboard.service.test.ts, apps/web/app/page.tsx, docs/infrastructure/m5-kubernetes.md]
  verification_command: focused preview URL tests; real kind/Envoy routing acceptance; browser navigation to emitted URL
  next_action: rerun real kind/Envoy/browser routing after the BuildKit registry endpoint is staged
  blocker: implementation checkpoint is complete; real routing acceptance awaits the BuildKit-to-Compose registry endpoint
  acceptance: the emitted dashboard and GitHub Check URL is directly clickable at the configured loopback Gateway port, routes only the matching host, and does not weaken production URL validation
  evidence: shared URL contract, worker Check output, API/dashboard projections, and READY dashboard link implemented; focused checks pass; real kind/Envoy/browser acceptance remains pending
  evidence_commit: not-run

- id: M9-LOCAL-DEMO
  status: in-progress
  title: Prove the complete local user journey
  owner: PreviewForge delivery
  depends_on: [M9-LOCAL-RUNTIME, M9-ONBOARDING, M9-LOCAL-ROUTING]
  acceptance_ref: docs/plans/m9-local-product-experience.md#M9-LOCAL-DEMO
  owned_paths: [fixtures/m9/, scripts/m9/, docs/operations/local-github-app.md]
  verification_command: direct M9 browser/runtime acceptance against controlled GitHub fixtures and real disposable local dependencies
  next_action: execute the controlled fixture journey through browser/API/worker/runtime after the endpoint restage; inspect exact residue and rerun cleanly
  blocker: implementation and onboarding checks pass; real worker push, browser READY navigation, and final cleanup still wait for the BuildKit-to-Compose registry endpoint
  acceptance: the complete browser journey passes with duplicate/reordered delivery safety, stale-SHA fencing, immutable digest routing, redaction, repeated close cleanup, rerun safety, and zero owned residue
  evidence: deterministic M9 manifest/source, loopback GitHub OAuth/App/repository/source/Check fixture, and signed webhook journey runner implemented; manifest scan, credential scan, full pnpm check, and endpoint smoke checks pass; full browser/runtime acceptance remains unclaimed
  evidence_commit: not-run

- id: M9-ACCEPTANCE
  status: queued
  title: Close M9 local product experience with fresh evidence
  owner: PreviewForge delivery
  depends_on: [M9-LOCAL-DEMO]
  acceptance_ref: docs/plans/m9-local-product-experience.md#M9-ACCEPTANCE
  owned_paths: [docs/reports/, docs/reports/index.md, docs/backlog/active.md, docs/backlog/archive.md, docs/delivery/roadmap.md, docs/knowledge/previewforge-memory.md, README.md]
  verification_command: pnpm check; direct M9 acceptance; pnpm docs:check; git diff --check; exact post-teardown residue inspection
  next_action: keep active until every M9 slice passes root verification, fault sensitivity, second review, final documentation agreement, and zero-residue inspection
  blocker: waiting for M9-LOCAL-DEMO
  acceptance: every M9 exit item has fresh final-tree evidence, completed items are archived, no M9 entry remains active, and blocked M10 cloud work remains untouched
  evidence: not-run
  evidence_commit: not-run

- id: M10-CLOUD-DEMO
  status: blocked
  title: Deploy the deferred demo to EKS and ECR
  owner: PreviewForge delivery
  depends_on: [M9-ACCEPTANCE, explicit AWS budget approval]
  acceptance_ref: docs/plans/m9-local-product-experience.md#M10-CLOUD-DEMO
  owned_paths: [infrastructure/eks/, scripts/m10/cloud/, docs/infrastructure/m10-eks-ecr-demo.md, .github/workflows/m10-cloud-demo.yml]
  verification_command: not-run — AWS explicitly deferred
  next_action: obtain explicit maximum spend, billing alert, disposable account/region, and destroy-procedure approval before any AWS preflight or provisioning
  blocker: the user's AWS Free Tier is exhausted and no unapproved cloud spend is authorized
  acceptance: after the future unblock, the fixture reaches EKS READY through an immutable ECR digest, negative RBAC and network-policy probes pass, and close cleanup leaves no cloud demo residue
  evidence: blocked by cost boundary; no AWS calls made
  evidence_commit: not-run

~~~
