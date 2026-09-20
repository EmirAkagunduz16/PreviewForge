---
id: RPT-2026-09-20-m9-implementation-gate
type: session
status: checkpoint
date: 2026-09-20
vault_sync: pending
---

# M9 implementation and host gate — 2026-09-20

## Result

Commits `77c9324` and `8eec106` record the M9 local product experience
implementation checkpoints: ownership-safe runtime commands, GitHub onboarding
projections and UI states, the local preview URL contract, the controlled
GitHub fixture, the signed webhook journey runner, and the supporting
documentation and tests. This follow-up also repairs request-scoped API
controller injection, external GitHub installation ID lookup in the worker,
terminal deployment lease cleanup, and the fixture's valid Node base image.

M9 remains active. The dedicated rootless BuildKit boundary is now live and
returns a real worker, and local runtime readiness, browser onboarding, and
the fixture webhook idempotency/stale-SHA checks have passed. The final build
to kind/Envoy journey is still blocked by registry endpoint configuration: the
rootless daemon is configured for its loopback registry at `127.0.0.1:5000`,
while the local worker was initially configured for the Compose registry at
`localhost:55000`. BuildKit completed the image build but refused the push
because the reachable kind-network endpoint is plain HTTP and was attempted
as HTTPS.

## Verification

- `set -a; source .env; set +a; PREVIEWFORGE_DOCKER_CONTEXT=default pnpm check`
  — passed before the final endpoint/runtime edits: Biome 239 files; 291
  Markdown links and context consistency; Turbo 21/21; database integration
  14 files/98 tests; API integration 6 files/8 tests; worker integration 1
  file/5 tests.
- `pnpm exec vitest run scripts/local/runtime.test.mjs packages/contracts/test/preview-url.test.ts`
  — 2 files/18 tests passed after the registry endpoint helper was added.
- `pnpm m9:fixture:check` — manifest and credential scan passed.
- focused API/controller tests — 6 files/32 tests passed;
  `apps/api/src/m2.integration.test.ts` — 1 test passed.
- focused worker/database tests — worker build input 2 tests passed; database
  deployment/project integration 2 files/18 tests passed.
- `pnpm docs:check` and `git diff --check` — passed before the current report
  refresh.
- Disposable PostgreSQL, Kafka, and registry services were started on the
  Docker `default` context for the integration gate and removed afterward.
- Host BuildKit evidence: staged configs under `/var/tmp/previewforge-buildkit`
  are owned by `previewforge-buildkit` with mode `0600`; the rootless child
  namespace, UID/GID maps, socket authorization, and `buildctl debug workers`
  all passed. The live worker ID was
  `mznlwmqkfsx16ehxgrx4yndop`.
- Rootless BuildKit reached the Compose registry through the kind bridge
  gateway `172.25.0.1:55000`; the direct probe failed only with
  `server gave HTTP response to HTTPS client`, confirming network reachability
  and isolating the remaining fix to daemon registry config.

## Host gate

- Docker `default` is the reachable `Victus/29.8.0` daemon.
- The dedicated `previewforge-buildkit` user, subordinate UID/GID ranges,
  BuildKit v0.33.0, registry v3.1.1, RootlessKit, slirp4netns, and
  fuse-overlayfs are installed and the accepted rootless stack is running.
- The previous stale `/var/tmp/previewforge-buildkit-local` marker is no
  longer the active socket; the live socket is
  `/var/tmp/previewforge-buildkit/buildkitd.sock`.
- The current runtime uses the Compose registry for kind pulls. Its BuildKit
  config must include the same kind bridge endpoint before the real worker push
  can complete.

## Next action

From an authenticated host terminal, stop the running rootless stack, restage
its BuildKit config with
`PREVIEWFORGE_BUILDKIT_REGISTRY_HOST=$(docker network inspect kind --format
'{{range .IPAM.Config}}{{println .Gateway}}{{end}}' | awk '/^[0-9]+([.][0-9]+){3}$/ { print; exit }'):55000`, restart it as
`previewforge-buildkit`, and verify `buildctl debug workers`. Then rerun
`pnpm local:up`, repeated `pnpm local:up`, `pnpm local:status`, the real worker
push, kind/Envoy routing, the browser navigation, child-failure propagation,
`pnpm local:down`, and exact process/socket/container/cluster residue checks.
Only after those fresh results should the active backlog move to complete.

No AWS calls, real GitHub credential, Docker socket mount, privileged mode,
host networking, global AppArmor/sysctl change, or production resource was
used.
