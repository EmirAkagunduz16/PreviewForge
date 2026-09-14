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
  owned_paths: [apps/worker/src/build/, scripts/m4-runner/, infrastructure/m4-runner/, .github/workflows/m4-buildkit-acceptance.yml]
  verification_command: DATABASE_URL=<local redacted value> BUILDKIT_ADDR=<local redacted value> pnpm --filter @previewforge/worker test:build:integration
  next_action: After a user-authorized push, dispatch the hosted workflow and require it to prove the child namespace, UID/GID maps, registry, socket authorization, and `buildctl debug workers` before calling startup fixed.
  blocker: The supplied hosted screenshot shows the socket-existence gate passing but the normal runner's `buildctl debug workers` failing with `EACCES`; no hosted run ID was supplied, and this repair has not yet been exercised by a hosted run.
  acceptance: Builds run without Docker socket, privileged/insecure entitlements, or unbounded wall time, resources, and logs.
  evidence: The canonical path verifies Ubuntu's package-owned, loaded, userns-capable profile without mutation; starts `/usr/bin/rootlesskit` directly; adds real child namespace/UID/GID-map gates; and grants the normal runner group access only to the daemon-owned BuildKit socket after readiness. Shell syntax, socket authorization regression (mocked ownership commands over a real disposable Unix socket, including denied/different-group, chown-race, missing/non-socket/symlink, and private-file mode checks), packaged-profile parser/content checks, docs consistency, diff check, and full `pnpm check` pass locally; hosted validation is not-run.
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
  next_action: After the packaged RootlessKit profile path passes hosted startup steps 1–5, require the fixture build, registry push, and immutable `sha256` digest verification to pass in the same real workflow.
  blocker: The custom profile path failed before rootless namespace creation in hosted run 34854326618. Keep the slice blocked until all eight ordered hosted checks pass in one workflow run.
  acceptance: Public/private fixture builds complete or fail safely, credentials never leak, retries are idempotent, stale work cannot publish, and cleanup leaves zero residue.
  evidence: Harness added; full `pnpm check` passes locally with database 78/78, API 1/1, and worker 5/5 integration tests. Hosted run 34854326618 failed before ordered acceptance step 1 under the retired custom profile; no real run has yet proved child namespace, UID/GID maps, registry, BuildKit socket/workers, fixture build, push, and digest in one pass.
  evidence_commit: not-run
```
