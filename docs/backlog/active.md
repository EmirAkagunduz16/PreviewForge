# Active backlog

Only unfinished work belongs here. Update this file before starting work and before handing off.

## M4 — Rootless image build

```yaml
- id: M4-SOURCE
  status: needs-review
  title: Acquire a bounded repository archive outside the BuildKit trust zone
  owner: root
  depends_on: [M3]
  acceptance_ref: docs/plans/m4-rootless-image-build.md#M4-SOURCE
  owned_paths: [apps/worker/src/source/, apps/worker/src/config.ts, apps/worker/src/source.test.ts]
  verification_command: pnpm --filter @previewforge/worker test -- source
  next_action: Root-review the source adapter boundary, then connect the materialized context to the deployment build orchestration.
  acceptance: A private fixture archive is fetched with a short-lived installation token that cannot enter the build context, logs, or retained files.
  evidence: Worker unit suite passed 9 files/93 tests; source-specific tests cover exact commit URL, auth redirect scrubbing, unsafe input rejection, bounded body, token-provider error redaction, stable 401/403/404/429/500 mapping, disposable tar extraction, Dockerfile validation, and cleanup. Typecheck, build, Biome, and diff check passed.
  evidence_commit: not-run

- id: M4-BUILDKIT
  status: blocked
  title: Execute Dockerfiles through a dedicated rootless BuildKit adapter
  owner: root
  depends_on: [M4-SOURCE]
  acceptance_ref: docs/plans/m4-rootless-image-build.md#M4-BUILDKIT
  owned_paths: [apps/worker/src/build/, infrastructure/local/compose.yaml, infrastructure/local/README.md, infrastructure/m4-runner/apparmor/previewforge-rootlesskit]
  verification_command: DATABASE_URL=<local redacted value> BUILDKIT_ADDR=<local redacted value> pnpm --filter @previewforge/worker test:build:integration
  next_action: Rerun the hosted workflow with the narrowly updated AppArmor profile and inspect any subsequent exact denial before changing the profile again.
  blocker: The repository profile now permits only the three reads observed during UID/GID-map setup in hosted run 34850233883 (`/etc/nsswitch.conf`, `/etc/passwd`, and `/var/tmp/previewforge-buildkit/`), but the updated profile has not yet run on the disposable hosted runner.
  acceptance: Builds run without Docker socket, privileged/insecure entitlements, or unbounded wall time, resources, and logs.
  evidence: Adapter unit tests cover shell-free args, timeout/unavailable/failure classification, invalid digest rejection, and unsafe input. Hosted run 34850233883 at `3126055` proved the confined `aa-exec` profile and explicit `/var/tmp/previewforge-buildkit/rootlesskit-state` advance past the earlier exec/state failures. Its three exact read denials during UID/GID-map setup are now allowed in the repository profile; `apparmor_parser -Q -T`, M4 shell syntax, and `git diff --check` pass locally. Full `pnpm check` passed with database 78/78, API 1/1, and worker 5/5 integration tests. Updated hosted build/push remains not-run.
  evidence_commit: not-run

- id: M4-REGISTRY
  status: in-progress
  title: Push and persist an immutable OCI digest under the desired-SHA guard
  owner: root
  depends_on: [M4-BUILDKIT]
  acceptance_ref: docs/plans/m4-rootless-image-build.md#M4-REGISTRY
  owned_paths: [apps/worker/src/build/, apps/worker/src/deployment-consumer.ts, packages/database/src/deployment-repository.ts]
  verification_command: DATABASE_URL=<local redacted value> REGISTRY_URL=localhost:55000 pnpm --filter @previewforge/worker test:registry:integration
  next_action: Add real Kafka/PostgreSQL duplicate, retry, and stale-SHA acceptance coverage; run it only after the authorized rootless BuildKit runner is available.
  acceptance: Only the current desired commit can persist an OCI digest; stale builds are superseded and mutable tags never become deployment identity.
  evidence: Runtime wiring now constructs ProjectRepository, GitHub installation-token provider, source client, BuildKit adapter, and the claimed-event pipeline when the complete M4 config is present; incomplete M4 config fails closed. DeploymentRepository validates and persists only `sha256:<64 hex>` digests on the desired-SHA-guarded `PUSHING -> DEPLOYING` transition. PostgreSQL integration suite passed 11 tests; worker unit suite passed 12 files/105 tests; targeted real Kafka/PostgreSQL claim-hook redelivery test passed.
  evidence_commit: not-run

- id: M4-ACCEPTANCE
  status: blocked
  title: Prove source, rootless build, registry, failure, timeout, and secret-boundary behavior end to end
  owner: root
  depends_on: [M4-SOURCE, M4-BUILDKIT, M4-REGISTRY]
  acceptance_ref: docs/plans/m4-rootless-image-build.md#M4-ACCEPTANCE
  owned_paths: [apps/worker/src/m4.integration.test.ts, apps/worker/package.json, package.json, docs/reports/]
  verification_command: DATABASE_URL=<local redacted value> BUILDKIT_ADDR=<local redacted value> REGISTRY_URL=localhost:55000 pnpm test:acceptance
  next_action: Rerun the hosted workflow with the narrow UID-lookup read allowances, then require smoke-check plus build → push → immutable digest verification to pass.
  blocker: The three proven AppArmor read denials are fixed in the repository profile but are not hosted-runner verified. Keep the slice blocked until the complete workflow is green.
  acceptance: Public/private fixture builds complete or fail safely, credentials never leak, retries are idempotent, stale work cannot publish, and cleanup leaves zero residue.
  evidence: Harness added; repository `pnpm check` passed against clean PostgreSQL/Kafka volumes with database 78/78, API 1/1, and worker 5/5 integration tests. Successive hosted runs have validated baseline, provisioning, pinned binary installation, profile verification, staging, explicit confined-profile selection, and private state-directory selection. Run 34850233883 exposed the three exact AppArmor reads now added to the profile; local parser and shell checks pass, but no updated run has yet reached the real build/push/digest oracle.
  evidence_commit: not-run
```
