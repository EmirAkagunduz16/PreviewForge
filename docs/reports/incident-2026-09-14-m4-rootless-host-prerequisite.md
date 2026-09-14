---
id: RPT-2026-09-14-m4-rootless-host-prerequisite
type: incident
status: verified
date: 2026-09-14
vault_sync: pending
---

# M4 rootless BuildKit host prerequisite

## Context

M4 requires a dedicated rootless BuildKit endpoint for untrusted Dockerfiles. The repository
does not currently include a BuildKit service, and the host has no `buildctl` or `buildkitd`
binary.

## Verified finding

The pinned multi-architecture `moby/buildkit` rootless image was pulled successfully at digest
`sha256:80b15f0735e87bab7bf59ec4d695dfb4a7cfb25521cf56dc75d6f256285b63ef`. Starting it with
the required rootless container security options fails before BuildKit starts because the host
sets `apparmor_restrict_unprivileged_userns=1`; rootlesskit cannot create its user namespace.

The M4 source-boundary slice is independent and verified: worker unit tests pass 8 files/91
tests, including bounded archive reads, unsafe input rejection, redirect token scrubbing, and
stable upstream error mapping. No BuildKit behavior is claimed yet.

BuildKit adapter unit tests additionally cover shell-free argument construction, bounded
timeout/output, safe infrastructure error mapping, digest-only metadata, and a scrubbed
child-process environment.

The source boundary now also materializes the bounded archive into a disposable extracted
context, validates the requested Dockerfile as a regular file, and removes the context on
success or failure. This remains outside the BuildKit process boundary and does not pass the
installation token into the context.

The database boundary now accepts an image digest only on the guarded `PUSHING -> DEPLOYING`
transition, validates the immutable `sha256:<64 hex>` form, and persists it together with the
desired-SHA compare-and-set. The worker-side pipeline now calls this path after a successful
BuildKit push, maps infrastructure errors to durable failure codes, and returns `SUPERSEDED`
when the desired SHA changes before publication. Wiring the pipeline into the claimed Kafka
handler is now represented by an after-claim hook that runs only for `CLAIMED`/`RECLAIMED`
deliveries; duplicate active leases do not rerun the build. The runtime still needs a project
configuration resolver for Dockerfile path and transport image reference before this hook can
invoke the pipeline in production.

That resolver is now implemented with project/event identity checks, Dockerfile path validation,
registry-host validation, and a deployment-specific immutable transport reference. The token
provider now mints a short-lived App JWT, exchanges it for an installation token, and maps
upstream failures without exposing response bodies or token values. `main.ts` now wires the
project lookup, source client, BuildKit adapter, and pipeline behind an all-or-nothing M4 worker
configuration; partial configuration fails closed.

## Evidence

- `command -v buildctl` and `command -v buildkitd`: no result.
- `docker buildx imagetools inspect moby/buildkit:rootless`: digest recorded above.
- `docker pull moby/buildkit@sha256:80b15f0735e87bab7bf59ec4d695dfb4a7cfb25521cf56dc75d6f256285b63ef`: passed.
- Rootless start attempt failed with `rootlesskit: ... apparmor_restrict_unprivileged_userns ... permission denied`.
- `pnpm --filter @previewforge/worker test:unit`: 7 files/83 tests passed.
- `BUILDKIT_ADDR=tcp://127.0.0.1:1234 REGISTRY_URL=localhost:55000 pnpm --filter @previewforge/worker test:build:integration`: failed closed with `BuildKitInfrastructureError: BUILDKIT_UNAVAILABLE`; no image build/push was reported as successful.
- Worker typecheck/build, Biome, `git diff --check`, and `pnpm docs:check`: passed.
- Worker unit suite after context materialization: 9 files/93 tests passed.
- PostgreSQL deployment repository integration: 11 tests passed, including digest persistence
  and invalid-digest rejection.
- Worker build pipeline unit suite: 10 files/96 tests passed.
- Worker runtime wiring and installation-token provider raised the unit suite to 12 files/105 tests.
- Targeted real Kafka/PostgreSQL claim-hook redelivery acceptance passed: the hook ran once,
  offset redelivery was acknowledged by the durable receipt, and the duplicate active lease did
  not rerun the hook.
- Read-only runner audit on the local host: `rootlesskit`, `newuidmap`, and `newgidmap` exist;
  `buildctl`, `buildkitd`, `slirp4netns`, and `fuse-overlayfs` are absent; AppArmor reports
  `kernel.apparmor_restrict_unprivileged_userns=1`; no dedicated `previewforge` subuid/subgid
  entries are present; profile inspection requires elevated privilege.
- The earlier self-hosted runner inventory was empty; the acceptance design now removes that
  dependency and targets GitHub-hosted `ubuntu-24.04` instead.
- Repository-side preparation is complete: the disposable Ubuntu 24.04 runbook, pinned image
  reference, checksum-pinned BuildKit binary installer, prerequisite audit, narrow AppArmor
  profile template, hosted-runner workflow, and immutable version manifest are present under `infrastructure/m4-runner/`,
  `scripts/m4-runner/`, and `.github/workflows/`.
- Worker consumer/pipeline unit suite: 10 files/98 tests passed, including duplicate-lease
  suppression.
- Worker build-input resolver raised the unit suite to 11 files/100 tests.
- Worker installation-token provider raised the unit suite to 12 files/104 tests.

## Impact / consequences

M4-BUILDKIT, M4-REGISTRY, and M4-ACCEPTANCE cannot claim real BuildKit evidence until a host
or CI runner permits rootless user namespaces. Enabling the AppArmor policy is a privileged
system change and is intentionally not performed implicitly. The local registry remains
available, but a registry alone is not a build proof.

## Network topology decision

The first runner draft described a private TCP BuildKit endpoint while also using a rootless
network with host loopback disabled. That left the registry's `127.0.0.1:5000` address
unreachable from the BuildKit namespace. The canonical design is now a single RootlessKit
`slirp4netns` namespace containing both the rootless registry and `buildkitd`:

- the registry binds `127.0.0.1:5000` **inside** that namespace;
- RootlessKit keeps `--disable-host-loopback` and forwards only
  `127.0.0.1:5000:5000/tcp` to the VM's host loopback;
- BuildKit pushes to `127.0.0.1:5000` in its own shared namespace;
- the runner reaches BuildKit only through
  `unix:///var/tmp/previewforge-buildkit/buildkitd.sock`;
- BuildKit is given a runtime-copied daemon config with `http = true` only for
  `127.0.0.1:5000`; `insecure = true` is not used;
- no BuildKit TCP listener, VM-interface bind, public registry bind, privileged mode, Docker
  socket, or global AppArmor/sysctl relaxation is used.

This topology is documented in the [canonical runner runbook](../../infrastructure/m4-runner/README.md)
and is the only endpoint model accepted for the M4 workflow.

## Hosted-runner decision

The external VM/self-hosted runner path was removed because the repository is public and GitHub's
standard `ubuntu-24.04` job already provides a fresh disposable VM. The workflow now provisions
the dedicated user, subuid/subgid range, AppArmor profile, checksum-pinned BuildKit binary, and
checksum-pinned Distribution registry inside the job. It first requires the hosted kernel to
expose `kernel.apparmor_restrict_unprivileged_userns=1` and AppArmor enabled; any mismatch fails
closed instead of widening policy. The small fixture fits the hosted runner's documented 14-GB
SSD, so the former 40-GB external-VM requirement is no longer canonical.

## Prevention / next action

Provision an explicitly authorized disposable Ubuntu 24.04 runner with the policy already
configured, run the checksum-pinned stack from the hosted workflow, and execute the real
build/registry acceptance matrix. If the hosted image fails the AppArmor preflight or
`--profile-test`, report it as an infrastructure blocker rather than widening security policy.
Do not weaken the build by mounting a Docker socket or enabling insecure/privileged entitlements.

## Hosted AppArmor provisioning finding

The first GitHub-hosted `ubuntu-24.04` run passed the baseline checks (`Ubuntu 24.04.5`,
`kernel.apparmor_restrict_unprivileged_userns=1`, and AppArmor enabled) but failed during the
provisioning call to `aa-enforce previewforge-rootlesskit` with:

```text
ERROR: Operation {'runbindable'} cannot have a source. Source = AARE('/')
```

The target profile is already loaded explicitly by the preceding `apparmor_parser -r` command;
the failing `aa-enforce` helper performs a broader hosted-image profile scan and can parse an
unrelated `passt`/`pasta` mount profile. The failure is therefore isolated to the helper's
unrelated-profile scan rather than used as evidence that the PreviewForge profile is invalid.

The provisioning path now removes `aa-enforce` entirely. It loads only the target profile with
`apparmor_parser -r`, then verifies the target's kernel state is `(enforce)`. The prerequisite
check repeats that read-only active/enforce verification and fails closed if the target profile is
missing or in another mode. No global AppArmor/sysctl change or unrelated profile mutation is
performed.

## Hosted checkout permission finding

The next hosted run completed AppArmor provisioning and binary installation but failed when the
rootless user tried to read `infrastructure/m4-runner/registry/config.yml` from the checkout.
The checkout is owned by the GitHub runner account and is not a supported configuration source for
the restricted daemon user. The fix is a root-only staging boundary:

- canonical repository templates are copied to `/var/tmp/previewforge-buildkit/` before privilege
  drop;
- generated runtime configs are owned by `previewforge-buildkit:previewforge-buildkit` and mode
  `0600`;
- `start-rootless-stack.sh` reads only those staged paths and fails closed otherwise;
- the acceptance client runs as the normal checkout user, reaching the daemon only through the
  narrowly group-accessible Unix socket path, so no repository, `.git`, ACL, or recursive mode
  change is required;
- rootlesskit/buildkitd receive an explicit credential-free environment allowlist.

The AppArmor profile remains unchanged because all runtime files and the socket stay below the
existing `/var/tmp/previewforge-buildkit/**` allowlist.

## RootlessKit user namespace profile conflict

The diagnostic hosted run captured the exact kernel records behind the `/proc/self/exe` userspace
error:

```text
apparmor="AUDIT" operation="exec" info="conflicting profile attachments" name="/usr/bin/rootlesskit"
apparmor="AUDIT" operation="userns_create" target="unprivileged_userns" execpath="/usr/bin/rootlesskit"
apparmor="DENIED" operation="capable" profile="unprivileged_userns" capname="sys_admin"
```

There was no `/proc/self/exe` execute denial. The custom profile and Ubuntu's packaged rootlesskit
profile both attached to `/usr/bin/rootlesskit`; the conflict prevented the custom confined profile
from governing namespace creation, and AppArmor transitioned the process into
`unprivileged_userns`, where the required namespaced `sys_admin` capability was denied.

Ubuntu's packaged profile uses the per-binary `flags=(unconfined) { userns, }` model. PreviewForge
does not modify that system profile or adopt its unconfined security trade-off. Instead, the custom
confined profile drops its automatic executable attachment and is selected explicitly through
`aa-exec -p previewforge-rootlesskit`. This preserves its existing `userns`, capability, filesystem,
socket, and credential-deny rules without adding broad `/proc` execution access.

## RootlessKit state-directory confinement

The following hosted run proved that explicit confined-profile selection passed the earlier
`/proc/self/exe` stage, then failed immediately with:

```text
[rootlesskit:parent] error: creating a state directory:
mkdir /tmp/rootlesskit1947753381: permission denied
```

This is RootlessKit's documented fallback when `--state-dir` is omitted, not evidence that the
profile needs general `/tmp` write access. The canonical start command now supplies
`--state-dir /var/tmp/previewforge-buildkit/rootlesskit-state`. The dedicated user owns that
directory with mode `0700`, and the path is already inside the narrow runtime allowlist. The start
script rejects a symlink or unexpected ownership/mode before launch. No `/tmp/**` rule or other
profile expansion was added.

## Related links

- [M4 plan](../plans/m4-rootless-image-build.md)
- [M4 runner prerequisite](../infrastructure/m4-rootless-buildkit.md)
- [M4 active backlog](../backlog/active.md)
- [ADR 0004](../architecture/decisions/0004-rootless-buildkit.md)
