---
id: RPT-2026-09-18-m9-local-demo-fixture-checkpoint
type: session
status: checkpoint
date: 2026-09-18
vault_sync: not yet synced
---

# M9 local demo fixture checkpoint — 2026-09-18

## Result

The next local-product slice now has a deterministic, credential-free GitHub
boundary. The M9 fixture contains one HTTP application, fixed pull-request
payloads, duplicate/synchronize/close cases, a loopback OAuth/App/repository/
source/Check Run server, ownership-marked temporary state, and a signed webhook
journey runner. No real GitHub account, token, private key, public tunnel, or
AWS resource is part of the fixture.

This is an implementation checkpoint, not full M9 acceptance. The runner does
not claim a healthy PostgreSQL/Kafka/BuildKit/kind/Envoy/API/worker/browser
topology; those boundaries still require the local runtime gate.

## Changed surface

- `fixtures/m9/`: manifest, pull-request/check payloads, source Dockerfile and
  HTTP application, and the controlled HTTP behavior matrix.
- `scripts/m9/fixtures/manifest.mjs`: path, identity, SHA, ownership, and
  credential-shaped content validation.
- `scripts/m9/github-fixture.mjs`: loopback-only OAuth, installation,
  repository/content/source archive, and Check Run endpoints with exact
  disposable state cleanup; typed fixture errors preserve expected HTTP
  statuses for negative auth/input cases.
- `scripts/m9/run-local-demo.mjs`: signed open/duplicate/synchronize/stale/
  close delivery sequence plus pretty-body signature negative check.
- `docs/operations/local-github-app.md`: controlled fixture setup, disposable
  key boundary, local journey commands, and separate real-GitHub path.
- `package.json`: `m9:fixture:check`, `m9:github-fixture`, and `m9:demo` commands.

## Verification

Passed:

- `pnpm m9:fixture:check` — manifest and full fixture credential scan passed.
- `node --check scripts/m9/fixtures/manifest.mjs`.
- `node --check scripts/m9/github-fixture.mjs`.
- `node --check scripts/m9/run-local-demo.mjs`.
- Controlled loopback smoke: repository listing returned the pull-enabled and
  pull-disabled repositories; source tarball redirect returned a gzip archive;
  OAuth redirect and Check Run creation paths responded as designed; an
  invalid bearer token returned the expected `401` without exposing fixture
  details.
- Fixture process teardown removed the exact `/tmp/previewforge-m9-github-fixture`
  state directory and generated archive.
- Repository-wide `pnpm check` reached all 21 Turbo typecheck/test/build tasks
  successfully; its final integration stage stopped before execution because
  `DATABASE_URL` is not configured on this host. The 13 Biome warnings are the
  pre-existing M8 acceptance-runner warnings and are outside this fixture
  change.
- `git diff --check`.

Not run:

- `pnpm m9:demo`: it must run after a local API has imported the fixture
  repository, otherwise webhook events correctly receive the API's
  `WEBHOOK_PROJECT_NOT_FOUND` boundary response.
- Browser sign-in/install/import, real worker build/READY, Envoy routing,
  live-log reconnect, failure/retry injection, close cleanup, and rerun.
- Full integration gate: this host still lacks `DATABASE_URL` and the accepted
  local Docker/rootless BuildKit prerequisites.

## Next action

Keep M9-LOCAL-DEMO in progress. Once the local runtime and controlled browser
path are available, run the fixture through sign-in, installation, import,
webhook journey, immutable READY preview navigation, failure/retry, logs, close,
exact residue inspection, and a clean rerun. Keep the real GitHub setup path
separate from the controlled fixture.

No real credential, privileged workload, Docker socket mount, host networking,
global AppArmor/sysctl change, or cloud mutation was introduced.
