---
id: RPT-2026-09-20-m9-implementation-gate
type: session
status: checkpoint
date: 2026-09-20
vault_sync: pending
---

# M9 implementation and host gate — 2026-09-20

## Result

Commit `77c9324` records the M8 local-gate handoff and the M9 local product
experience implementation checkpoints: the ownership-safe runtime commands,
GitHub onboarding projections and UI states, local preview URL contract,
controlled GitHub fixture, signed webhook journey runner, and the supporting
documentation and tests.

M9 remains active. The repository and disposable dependency gates pass, but
the complete local runtime and browser/kind/Envoy journey are not claimed as
accepted because the dedicated rootless BuildKit socket could not be started
from this Codex shell.

## Verification

- `set -a; source .env; set +a; PREVIEWFORGE_DOCKER_CONTEXT=default pnpm check`
  — passed: Biome 239 files; 291 Markdown links and context consistency;
  Turbo 21/21; database integration 14 files/98 tests; API integration 6
  files/8 tests; worker integration 1 file/5 tests.
- `pnpm exec vitest run scripts/local/runtime.test.mjs packages/contracts/test/preview-url.test.ts`
  — 2 files/17 tests passed.
- `pnpm m9:fixture:check` — manifest and credential scan passed.
- `pnpm docs:check` and `git diff --check` — passed.
- Disposable PostgreSQL, Kafka, and registry services were started on the
  Docker `default` context for the integration gate and removed afterward.

## Host gate

- Docker `default` is the reachable `Victus/29.8.0` daemon when the host
  socket is available.
- The dedicated `previewforge-buildkit` user, subordinate UID/GID ranges,
  BuildKit v0.33.0, registry v3.1.1, RootlessKit, slirp4netns, and
  fuse-overlayfs are installed.
- The recorded socket at `/var/tmp/previewforge-buildkit-local/buildkitd.sock`
  was stale; `buildctl debug workers` returned connection refused.
- The accepted `/var/tmp/previewforge-buildkit` directory is owned by the
  dedicated user and is not writable through this shell. `sudo -n -u
  previewforge-buildkit` requires a host password, so the root-only staging and
  dedicated-user start scripts could not run here.
- A current-user RootlessKit smoke process did expose a real BuildKit worker
  under `/tmp`, but it is not evidence for the accepted dedicated-user M4
  boundary and was terminated without entering the M9 runtime drill.
- `pnpm local:status` reports the old `/var/tmp/previewforge-local` marker as
  stale with no live child processes or open local ports. Its host-side removal
  remains part of the authenticated terminal next action.

## Next action

From an authenticated host terminal, stage the pinned rootless runtime config,
start it as `previewforge-buildkit`, verify `buildctl debug workers`, then run
`pnpm local:up`, a repeated `pnpm local:up`, `pnpm local:status`, child-failure
propagation, `pnpm local:down`, and exact process/socket/container/cluster
residue checks. After that gate, run the controlled GitHub browser journey and
real kind/Envoy preview routing before changing the active backlog to complete.

No AWS calls, real GitHub credential, Docker socket mount, privileged mode,
host networking, global AppArmor/sysctl change, or production resource was
used.
