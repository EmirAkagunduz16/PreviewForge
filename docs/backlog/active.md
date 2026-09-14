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
  next_action: Review the source adapter and materialized-context boundary; archive this slice only after the private-fixture acceptance proves token and cleanup invariants.
  acceptance: A private fixture archive is fetched with a short-lived installation token that cannot enter the build context, logs, or retained files.
  evidence: Worker unit suite passed 9 files/93 tests; source-specific tests cover exact commit URL, auth redirect scrubbing, unsafe input rejection, bounded body, token-provider error redaction, stable 401/403/404/429/500 mapping, disposable tar extraction, Dockerfile validation, and cleanup. Typecheck, build, Biome, and diff check passed.
  evidence_commit: not-run

- id: M4-BUILDKIT
  status: needs-review
  title: Execute Dockerfiles through a dedicated rootless BuildKit adapter
  owner: root
  depends_on: [M4-SOURCE]
  acceptance_ref: docs/plans/m4-rootless-image-build.md#M4-BUILDKIT
  owned_paths: [apps/worker/src/build/, scripts/m4-runner/, infrastructure/m4-runner/, .github/workflows/m4-buildkit-acceptance.yml, docs/infrastructure/m4-rootless-buildkit.md, docs/backlog/active.md]
  verification_command: DATABASE_URL=<local redacted value> BUILDKIT_ADDR=<local redacted value> pnpm --filter @previewforge/worker test:build:integration
  next_action: Review the BuildKit adapter boundary and archive this slice after the hosted evidence plus failure/timeout/resource-limit checks are linked.
  blocker: none
  acceptance: Builds run without Docker socket, privileged/insecure entitlements, or unbounded wall time, resources, and logs.
  evidence: The canonical path verifies Ubuntu's package-owned, loaded, userns-capable profile without mutation; starts `/usr/bin/rootlesskit` directly; adds real child namespace/UID/GID-map gates; and grants the normal runner group access only to the daemon-owned BuildKit socket after readiness. Shell syntax, socket authorization regression (mocked ownership commands over a real disposable Unix socket, including denied/different-group, chown-race, missing/non-socket/symlink, and private-file mode checks), packaged-profile parser/content checks, docs consistency, diff check, and full `pnpm check` pass locally. Hosted run [34860645607](https://github.com/EmirAkagunduz16/PreviewForge/actions/runs/34860645607) at commit `e099ade` passed namespace/maps, registry readiness, socket authorization, normal-user `buildctl debug workers`, fixture build, registry push, immutable digest verification, and cleanup.
  evidence_commit: e099ade

- id: M4-REGISTRY
  status: in-progress
  title: Push and persist an immutable OCI digest under the desired-SHA guard
  owner: root
  depends_on: [M4-BUILDKIT]
  acceptance_ref: docs/plans/m4-rootless-image-build.md#M4-REGISTRY
  owned_paths: [apps/worker/src/build/, apps/worker/src/deployment-consumer.ts, packages/database/src/deployment-repository.ts]
  verification_command: DATABASE_URL=<local redacted value> KAFKA_BROKERS=localhost:59092 BUILDKIT_ADDR=<local redacted value> REGISTRY_URL=localhost:55000 pnpm --filter @previewforge/worker test:acceptance:m4
  next_action: Add and run the real Kafka/PostgreSQL/BuildKit registry acceptance covering duplicate delivery, retry, stale SHA, and digest persistence in apps/worker/src/m4.integration.test.ts.
  acceptance: Only the current desired commit can persist an OCI digest; stale builds are superseded and mutable tags never become deployment identity.
  evidence: Runtime wiring now constructs ProjectRepository, GitHub installation-token provider, source client, BuildKit adapter, and the claimed-event pipeline when the complete M4 config is present; incomplete M4 config fails closed. DeploymentRepository validates and persists only `sha256:<64 hex>` digests on the desired-SHA-guarded `PUSHING -> DEPLOYING` transition, and `supersedeIfStale` now durably records active stale work with an outbox event. PostgreSQL integration suite passed 79 tests; worker unit suite passed 12 files/106 tests; targeted real Kafka/PostgreSQL claim-hook redelivery test passed. The new M4 real source/BuildKit/registry integration test is added but awaits hosted rootless execution.
  evidence_commit: not-run

- id: M4-ACCEPTANCE
  status: in-progress
  title: Prove source, rootless build, registry, failure, timeout, and secret-boundary behavior end to end
  owner: root
  depends_on: [M4-SOURCE, M4-BUILDKIT, M4-REGISTRY]
  acceptance_ref: docs/plans/m4-rootless-image-build.md#M4-ACCEPTANCE
  owned_paths: [apps/worker/src/m4.integration.test.ts, apps/worker/package.json, package.json, docs/reports/]
  verification_command: DATABASE_URL=<local redacted value> BUILDKIT_ADDR=<local redacted value> REGISTRY_URL=localhost:55000 pnpm test:acceptance
  next_action: Extend apps/worker/src/m4.integration.test.ts with public/private source, failure, timeout, duplicate-delivery, and credential-boundary scenarios; archive M4 only after the complete matrix passes.
  blocker: none
  acceptance: Public/private fixture builds complete or fail safely, credentials never leak, retries are idempotent, stale work cannot publish, and cleanup leaves zero residue.
  evidence: Harness added; full local `pnpm check` passes with database 79/79, API 1/1, and worker 5/5 integration tests. Hosted run [34860645607](https://github.com/EmirAkagunduz16/PreviewForge/actions/runs/34860645607) at commit `e099ade` proved rootless namespace/maps, registry readiness, BuildKit socket authorization, normal-user workers, one fixture build, registry push, immutable digest verification, and cleanup in one run. The expanded M4 source/BuildKit/registry integration test and remaining public/private source, failure, timeout, duplicate-delivery, and credential-boundary matrix await the next hosted run.
  evidence_commit: not-run
```
