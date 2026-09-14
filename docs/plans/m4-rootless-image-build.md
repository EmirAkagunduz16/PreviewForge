# M4 execution plan — rootless image build

Status: complete
Completion evidence: [M4 hosted handoff](../reports/session-2026-09-14-m4-hosted-handoff.md) and [backlog archive](../backlog/archive.md)
Owner: PreviewForge delivery
Baseline before planning: `d6003c1ba84ba32d4e3e1443c111eebed3b19c8b`
Sources: [delivery roadmap](../delivery/roadmap.md), [MVP scope](../product/mvp-scope.md), [system design](../architecture/system-design.md), [ADR 0004](../architecture/decisions/0004-rootless-buildkit.md), [threat model](../security/threat-model.md), [runner prerequisite](../infrastructure/m4-rootless-buildkit.md)

## Outcome

Move a claimed deployment from `CLONING` through a policy-bounded rootless BuildKit build to
an immutable registry digest. Source acquisition uses a short-lived GitHub App installation
token outside the build trust zone. M4 does not create Kubernetes resources, publish GitHub
checks, or claim a production multi-tenant sandbox.

## Locked decisions

- Keep source acquisition and image build in separate trust zones. The installation token is
  used only for the archive request, is never written into the source tree or build arguments,
  and is discarded before BuildKit starts.
- Use the existing worker process and a narrow BuildKit adapter; do not add a service boundary.
  BuildKit is the dedicated rootless service accepted by ADR 0004. Never mount a Docker socket,
  enable privileged/insecure entitlements, or use host networking for user builds.
- Build one Dockerfile and one HTTP container per project. The configured project Dockerfile
  path is validated before source acquisition; arbitrary manifests and Compose files remain out
  of scope.
- Tagging is only a transport convenience. Deployment identity is the resolved OCI digest,
  persisted only after push and still guarded by the deployment's desired SHA.
- Apply bounded wall time, CPU, memory, disk/context, and log output. User build failures are
  durable stage failures and are not retried indiscriminately.
- For the GitHub-hosted disposable acceptance runner, keep the registry and rootless `buildkitd` in one
  RootlessKit `slirp4netns` namespace. BuildKit pushes to `127.0.0.1:5000` inside that
  namespace; the runner uses only
  `unix:///var/tmp/previewforge-buildkit/buildkitd.sock` and the RootlessKit loopback forward
  `127.0.0.1:5000`. Do not bind either service to a VM interface.
- Use Ubuntu 24.04's packaged `/usr/bin/rootlesskit flags=(unconfined) { userns, }` per-binary
  AppArmor model on the hosted runner. Do not install or expand a PreviewForge custom profile,
  invoke `aa-exec`, alter the global AppArmor/sysctl posture, or continue policy development inside
  M4. Fail closed if the packaged profile is absent, unexpected, or not loaded.
- Local acceptance uses the existing registry on `localhost:55000` and a disposable rootless
  BuildKit endpoint. It cannot claim production registry auth, multi-node BuildKit, or hostile
  tenant isolation.

## Dependency waves and ownership

All M4 work is root-owned because only one active agent is enabled for PreviewForge.

| Slice | Owned paths | Depends on |
|---|---|---|
| M4-SOURCE | `apps/worker/src/source/`, worker config/tests, source integration fixtures | M2 installation identity, M3 worker claims |
| M4-BUILDKIT | `apps/worker/src/build/`, BuildKit adapter/tests, hosted runner scripts and rootless wiring | M4-SOURCE |
| M4-REGISTRY | worker build persistence/transition integration, digest resolver, database tests if needed | M4-BUILDKIT |
| M4-ACCEPTANCE | root scripts, real source/build/registry acceptance, reports/backlog | all prior slices |

## Acceptance matrix

| Slice | Risk | Stimulus | Observable oracle | Fault sensitivity | Runtime |
|---|---|---|---|---|---|
| M4-SOURCE | Token leaks into context, logs, or retained files; wrong repository/SHA is fetched. | Controlled GitHub App fixture returns a private archive and token-like content; inject 401/404/5xx, redirect, oversized archive, wrong SHA. | Archive is fetched with an installation token, token is absent from files/logs, SHA/repository are validated, temp context is cleaned. | Remove token scrubbing, archive bounds, or identity checks and a targeted test fails. | Real HTTP fixture plus filesystem temp directory. |
| M4-BUILDKIT | Untrusted Dockerfile gains host privileges or unbounded resources; build output is not reproducible. | Dockerfile attempts socket/privileged/network entitlements, emits large logs, sleeps, or exits non-zero. | Rootless BuildKit rejects forbidden behavior; timeout/resource/log limits produce safe durable failure; successful build returns digest metadata. | Enable insecure entitlement or remove timeout/log limit and targeted test fails. | Disposable rootless BuildKit and local registry. |
| M4-REGISTRY | Mutable tag is treated as deployment identity or stale build overwrites desired work. | Push same transport tag twice, change desired SHA during build, resolve manifest digest after push. | Digest is immutable and persisted only for current desired SHA; stale build becomes `SUPERSEDED` and cannot publish. | Remove desired-SHA predicate or persist tag instead of digest and targeted test fails. | PostgreSQL, local OCI registry, real BuildKit. |
| M4-ACCEPTANCE | Narrow unit tests hide a broken source/build/push boundary. | Public/private fixture repositories, failed build, timeout, duplicate worker delivery, cleanup after success/failure. | Root worker acceptance proves no credential leakage, bounded failure, one digest, idempotent retry, and zero fixture residue. | Deliberate token/context/digest/desired-SHA faults fail before restoration. | Real PostgreSQL, GitHub HTTP fixture, rootless BuildKit, registry. |

## Exit checklist

- Source archive acquisition and BuildKit execution use separate credentials and filesystem trust zones.
- No credential appears in build args, context files, image layers, logs, database failure text, or
  API responses.
- Build resource and output limits are enforced and tested against timeout, failure, and log floods.
- Successful publication resolves and persists an OCI digest, never a mutable tag.
- Desired-SHA is rechecked before push completion is persisted; stale work is superseded.
- Real source/build/registry acceptance passes with public/private fixtures and cleanup.
- One hosted run proves, in order, RootlessKit child namespace, UID/GID maps, registry readiness,
  BuildKit Unix socket, `buildctl debug workers`, fixture build, registry push, and immutable
  digest verification. M4 is not complete on partial startup evidence.
- `pnpm check` passes with exact test counts and the local topology limitations recorded.
