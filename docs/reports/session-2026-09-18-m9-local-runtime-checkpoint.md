---
id: RPT-2026-09-18-m9-local-runtime-checkpoint
type: session
status: verified
date: 2026-09-18
vault_sync: not yet synced
---

# M9 local runtime checkpoint — 2026-09-18

## Result

The first M9 implementation slice adds a foreground local runtime supervisor
with `pnpm local:up`, `pnpm local:status`, and `pnpm local:down`. The supervisor
loads `.env` without printing values, rejects unsupported Docker/BuildKit
boundaries, records an ownership-marked state directory, starts or reuses the
local core services, provisions the named kind/Gateway path, waits for API,
worker, dashboard, and Gateway readiness, and cleans only child processes,
Compose containers, and kind clusters proven to be owned by this run.

The local dependency foundation is now exercised on the available Docker
Desktop `desktop-linux` context. Because the default host ports were already
occupied, the disposable PostgreSQL/Kafka/registry stack was run on
`55433/59093/55500`; all three containers reported healthy/running, ten
database migrations applied, and the full root integration gate passed. This
is still an implementation/integration checkpoint, not M9 acceptance: the
foreground supervisor has not completed its end-to-end drill, the accepted
dedicated rootless BuildKit socket has not been started and proven, and the
kind/Envoy/browser journey remains pending.

## Changed surface

- `scripts/local/runtime.mjs`: preflight, foreground supervisor, readiness,
  redacted status, managed BuildKit allowlist, and ownership-safe teardown.
- `infrastructure/local/compose.yaml` and
  `scripts/kubernetes/connect-local-registry.sh`: configurable local
  PostgreSQL, Kafka, and registry host ports with secure `55432/59092/55000`
  defaults, so unrelated occupied ports can be avoided without deleting or
  reconfiguring another resource.
- `scripts/local/runtime.test.mjs`: parser, Unix-socket, managed-command, and
  BuildKit credential-scrubbing tests.
- `package.json`, `.env.example`, `turbo.json`: local commands and runtime
  configuration boundary.
- `scripts/kubernetes/bootstrap-kind.sh`: explicit Kubernetes context for the
  local supervisor.
- `docs/operations/local-development.md`: prerequisites and operator flow.

## Verification

| Check | Observed result | Status |
|---|---|---|
| `pnpm exec vitest run scripts/local/runtime.test.mjs` | 1 file, 6 tests passed | Passed |
| `node --check scripts/local/runtime.mjs` | no syntax errors | Passed |
| Compose overrides with `PREVIEWFORGE_POSTGRES_LOCAL_PORT=55433`, `PREVIEWFORGE_KAFKA_LOCAL_PORT=59093`, `PREVIEWFORGE_REGISTRY_LOCAL_PORT=55500` | resolved `55433:5432`, `59093:9092`, and `55500:5000`; Kafka advertised the selected host port | Passed |
| Disposable local dependency gate | Docker Desktop `desktop-linux`; PostgreSQL, Kafka, and registry healthy/running; ten migrations applied | Passed |
| `pnpm test:integration` with `DATABASE_URL` on `55433` and `KAFKA_BROKERS=localhost:59093` | database: 14 files/98 tests; API: 6 files/8 tests; worker: 1 file/5 tests | Passed |
| Post-integration residue query | users, projects, preview environments, deployments, outbox events, log chunks, and project environment variables all `0`; registry catalog empty; no Kafka consumer groups | Passed |
| Exact disposable cleanup | `pnpm infra:down` removed only the three PreviewForge containers and network; no PreviewForge containers, local supervisor state, BuildKit state, or matching daemon processes remained | Passed |
| Biome on changed runtime/manifests | no findings | Passed |
| `pnpm docs:check` | 291 links across 78 files; context consistency passed | Passed |
| `git diff --check` | no whitespace errors | Passed |
| `pnpm local:up` with `PREVIEWFORGE_DOCKER_CONTEXT=desktop-linux` and override ports | fails closed before mutation because the accepted `buildctl` boundary is not installed on `PATH` | Blocked by rootless BuildKit prerequisite |
| `./scripts/m4-runner/check-prerequisites.sh --check` before provisioning | recorded missing `slirp4netns`, `fuse-overlayfs`, `buildkitd`, `buildctl`, `registry`, dedicated runner identity, and subuid/subgid ranges | Historical blocker |
| `sudo ./scripts/m4-runner/provision-ubuntu.sh` in the user-authenticated host terminal | Ubuntu 24.04 prerequisites now present: packaged RootlessKit helpers, AppArmor enabled/profile present, policy `1`, `previewforge-buildkit` identity, and subuid/subgid ranges | Passed |
| Pinned binary install/staging from Codex shell | not executable here because root-owned `/usr/local/bin` and `/var/tmp/previewforge-buildkit` require host authentication; no partial mutation observed | Blocked by shell privilege boundary |
| `docker --context desktop-linux info` | Docker Desktop `29.7.2` is available after explicit local start | Passed prerequisite |
| `pnpm local:status` after failed start | `stopped`; no `/var/tmp/previewforge-local` state | Passed safety check |
| `pnpm check` with the disposable database/Kafka environment | docs/context, 21/21 Turbo tasks, and database/API/worker integration gates passed | Passed |

## Next action

From the authenticated host terminal, install the checksum-pinned M4 BuildKit
and registry binaries and stage/start the rootless stack using the existing
scripts. Do not change global security policy. Then run the real disposable
drill: first start, status boundary inspection, repeated start idempotency,
foreground child-failure propagation, down, and exact process/socket/container/
cluster residue inspection. After that, run the real kind/Envoy/browser
onboarding and routing journey; M9 slices remain active until those gates are
evidenced.

No GitHub, AWS, Docker socket mount, privileged mode, host networking, global
AppArmor/sysctl change, or real credential was introduced.
