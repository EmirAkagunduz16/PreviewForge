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
  owned_paths: [apps/worker/src/build/, infrastructure/local/compose.yaml, infrastructure/local/README.md]
  verification_command: DATABASE_URL=<local redacted value> BUILDKIT_ADDR=<local redacted value> pnpm --filter @previewforge/worker test:build:integration
  next_action: Dispatch the GitHub-hosted `ubuntu-24.04` workflow, let its fail-closed AppArmor preflight and provisioning complete, then run the new `test:build:integration` against the shared-namespace Unix socket and loopback registry.
  blocker: Local host has no `buildctl`, `buildkitd`, `slirp4netns`, or `fuse-overlayfs`, has no dedicated previewforge subuid/subgid entries, and keeps `apparmor_restrict_unprivileged_userns=1`; the pinned rootless image cannot start under this policy. The hosted workflow must independently prove that its Ubuntu/AppArmor kernel permits the narrow profile; no host policy change is being performed implicitly.
  acceptance: Builds run without Docker socket, privileged/insecure entitlements, or unbounded wall time, resources, and logs.
  evidence: Adapter unit tests cover shell-free args, timeout/unavailable/failure classification, invalid digest rejection, and unsafe input. The opt-in real test was re-run locally and failed closed as `BUILDKIT_UNAVAILABLE` because `buildctl`/rootless BuildKit is unavailable; no build or push is claimed. Full repository checks passed before the hosted migration; the GitHub-hosted `ubuntu-24.04` workflow now owns provisioning, preflight, smoke checks, real acceptance, and always-cleanup. The canonical topology uses `unix:///var/tmp/previewforge-buildkit/buildkitd.sock` and a RootlessKit-forwarded `127.0.0.1:5000` registry.
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
  next_action: Dispatch `.github/workflows/m4-buildkit-acceptance.yml` on GitHub-hosted `ubuntu-24.04`; it provisions and validates the narrow runner/AppArmor profile before the real BuildKit/registry manifest-digest test.
  blocker: The hosted image's kernel/AppArmor behavior is not yet evidenced; if the workflow preflight or `--profile-test` fails, report that infrastructure incompatibility without weakening policy.
  acceptance: Public/private fixture builds complete or fail safely, credentials never leak, retries are idempotent, stale work cannot publish, and cleanup leaves zero residue.
  evidence: Harness added; repository `pnpm check` passed, but the BuildKit/registry leg remains not-run because the rootless BuildKit infrastructure prerequisite is unavailable.
  evidence_commit: not-run
```
