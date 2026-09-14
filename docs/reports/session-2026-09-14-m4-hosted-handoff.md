---
id: RPT-2026-09-14-session-m4-hosted-handoff
type: session
status: verified
date: 2026-09-14
vault_sync: synced
---

# M4 hosted rootless BuildKit handoff

## Context

M4 builds one repository Dockerfile through dedicated rootless BuildKit, pushes to a disposable
registry, and persists only an immutable digest while the deployment SHA remains desired. This
session kept PreviewForge on one active agent and treated the hosted acceptance as a fail-closed
security investigation rather than weakening the runner until it became green.

## Verified progress

- Source acquisition, bounded context materialization, the BuildKit adapter, installation-token
  boundary, worker pipeline wiring, desired-SHA-guarded digest persistence, and the acceptance
  harness are implemented.
- Normal CI now explicitly generates Prisma Client and provisions the canonical PostgreSQL/Kafka
  compose infrastructure before `pnpm check`.
- M4 acceptance runs on disposable GitHub-hosted `ubuntu-24.04`; no self-hosted registration or
  external VM lifecycle remains in the canonical path.
- BuildKit and the plain-HTTP registry share one RootlessKit `slirp4netns` namespace. Registry
  exposure is host loopback only, BuildKit uses a Unix socket, and `--disable-host-loopback`
  remains enabled.
- Runtime configs are staged before privilege drop. RootlessKit is selected through the named
  confined AppArmor profile with `aa-exec`, avoiding Ubuntu's competing executable attachment,
  and its private state directory is staged under `/var/tmp/previewforge-buildkit/` with mode
  `0700`.

## Evidence

- Repository evidence head: `312605534c53a0879b7015fe3af31da7dbaf767d`.
- Clean PostgreSQL/Kafka verification: root `pnpm check` passed; database integration 78/78, API
  integration 1/1, worker Kafka/PostgreSQL integration 5/5, and worker unit 105/105 passed.
- AppArmor parser dry-run, shell syntax, docs consistency, Biome, and `git diff --check` passed.
- Hosted runs successively proved Ubuntu/AppArmor baseline, narrow provisioning, checksum-pinned
  binary installation, profile verification, runtime staging, explicit confined-profile selection,
  and the private RootlessKit state-directory boundary.
- Hosted run [34850233883](https://github.com/EmirAkagunduz16/PreviewForge/actions/runs/34850233883)
  reached UID/GID-map setup, then recorded exact read denials for `/etc/nsswitch.conf`,
  `/etc/passwd`, and `/var/tmp/previewforge-buildkit/`.

## Security decisions retained

No global AppArmor/sysctl weakening, `--privileged`, runtime `apparmor=unconfined`,
`seccomp=unconfined`, Docker socket, BuildKit TCP listener, public registry bind, or credential
inheritance into the daemon was introduced. Permissions are changed only in response to exact
hosted kernel evidence.

## Open work / next action

M4 is not complete. Add only the three AppArmor reads proven by run `34850233883`, rerun the
hosted workflow, and repeat exact-denial diagnosis if another confined dependency appears. Do not
start M5 until the workflow proves registry and BuildKit readiness plus build → push → immutable
digest verification.

## Related links

- [M4 plan](../plans/m4-rootless-image-build.md)
- [Active backlog](../backlog/active.md)
- [Canonical M4 runner](../../infrastructure/m4-runner/README.md)
- [M4 host-prerequisite incident](incident-2026-09-14-m4-rootless-host-prerequisite.md)
- [VictusOS distillation](../../../../Documents/VictusOS/Reports/PreviewForge/2026-09-14%20M4%20Hosted%20Acceptance%20Handoff.md)
