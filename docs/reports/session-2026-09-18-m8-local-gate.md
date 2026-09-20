---
id: RPT-2026-09-18-m8-local-gate
type: session
status: verified
date: 2026-09-18
vault_sync: synced
---

# M8 local hardening gate rerun — 2026-09-18

## Result

The missing local rootless BuildKit boundary was restored as a disposable
rootless runtime and the complete M8 local acceptance runner passed. M8 local
hardening is now complete. M9-CLOUD-DEMO remains explicitly blocked and no AWS
credential, account, or resource was inspected or mutated.

The runtime was started with RootlessKit and `slirp4netns`, with
`--disable-host-loopback`, no Docker socket, no privileged flag, and no host
network. BuildKit v0.33.0 and buildctl reported the same upstream revision;
`buildctl debug workers` returned one worker on the expected Unix socket
`/var/tmp/previewforge-buildkit/buildkitd.sock`. The runtime was disposable and
was removed after verification. Hosted M4 provisioning evidence remains a
separate claim; this report only records the local M8 runtime boundary.

## Runtime identity

- Docker context: `default`.
- Kubernetes context: `kind-previewforge`; the disposable node was Ready.
- PostgreSQL: local Compose service on `127.0.0.1:55432`, PostgreSQL 18.1.
- Kafka: local Compose broker on `127.0.0.1:59092`, Kafka 4.3.1.
- Registry: local Compose registry on `127.0.0.1:55000`.
- Gateway: kind/Envoy through the loopback port-forward at
  `http://127.0.0.1:18080`.
- BuildKit: rootless v0.33.0 worker, Unix socket above.

## Acceptance evidence

| Boundary | Observed evidence | Result |
|---|---|---|
| Rootless BuildKit | `buildkitd` and `buildctl` reported v0.33.0; RootlessKit UID/GID namespace and `slirp4netns` startup passed; `buildctl debug workers` returned one worker; the M8 runner found the expected socket. | Passed |
| API failure matrix | `src/m8.integration.test.ts`: 1 file / 2 tests through the M8 runner. | Passed |
| Worker failure matrix | `src/m8.acceptance.test.ts`: 1 file / 6 tests through the M8 runner. | Passed |
| Restore/outbox drill | Fixture seed/repeat, isolated restore, outbox replay, and pending-row reduction completed successfully. | Passed |
| Observability | 19 API metric samples, 10 worker metric samples, 1 API trace, 23 worker trace spans, 2 Grafana dashboard entries, 3 Prometheus series, and Tempo `ready`. | Passed |
| Real Kubernetes/Gateway boundary | `pnpm test:acceptance:m5`: 1 file / 3 tests against kind and Envoy Gateway. | Passed |
| Repository verification | `pnpm check` and `git diff --check` passed after the M8 runner completed. | Passed |

## Residue and safety

- M8 probe rows in `kafka_deliveries` and `consumer_receipts`: `0` / `0`.
- The two exact M8 consumer groups created by this run were deleted; final M8
  group listing was empty.
- API, worker, runner, BuildKit, Gateway port-forward, and test processes were
  absent after teardown.
- Disposable Prometheus, Grafana, Tempo, OpenTelemetry Collector containers
  and their three volumes were removed. Base PostgreSQL, Kafka, registry, and
  the pre-existing kind cluster were intentionally preserved.
- The protected untracked `.codex/` directory was not touched. No product code
  was changed by this acceptance rerun.

## Commands

```bash
node scripts/m8/run-local-acceptance.mjs
pnpm check
git diff --check
```

The runner used loopback-only PostgreSQL/Kafka targets and the disposable
`kind-previewforge` context. API and worker startup used synthetic test-only
configuration; no real GitHub credential or AWS access was used.

## Closure

M8-E2E-FAULTS, M8-LOCAL-ACCEPTANCE, and M8-ACCEPTANCE can be archived with
this report as evidence. M9-CLOUD-DEMO remains active and blocked until the
explicit budget, billing alert, disposable account/region, and destroy
procedure are approved.
