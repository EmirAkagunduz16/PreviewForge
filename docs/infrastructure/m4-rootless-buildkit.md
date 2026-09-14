# M4 rootless BuildKit hosted-runner prerequisite

M4 acceptance runs on GitHub's disposable `ubuntu-24.04` runner. It is not an application
startup concern: the worker never changes kernel, AppArmor, subuid/subgid, Docker, or
container-runtime policy.

The [canonical workflow](../../.github/workflows/m4-buildkit-acceptance.yml) verifies the hosted
image first, provisions the rootless toolchain with passwordless `sudo`, runs the real acceptance,
and cleans up with `if: always()`. No self-hosted runner, external VM provisioning, registration token,
label, or repository endpoint variable is part of the M4 path.

## Hosted image and disk decision

The standard public-repository `ubuntu-24.04` runner is a fresh 4-vCPU, 16-GB RAM, 14-GB SSD VM.
The fixture is deliberately small and the workflow removes BuildKit cache, registry data, and
temporary context, so the old 40-GB VM requirement is removed. Any larger fixture must be checked
against the hosted disk before expanding the acceptance scope.

See [GitHub runner specifications](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
and the [Ubuntu 24.04 image inventory](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md).

## Security preflight and fail-closed behavior

Before provisioning, the workflow requires Ubuntu 24.04, passwordless `sudo`, AppArmor enabled,
and `kernel.apparmor_restrict_unprivileged_userns=1`. Provisioning then installs the named
`previewforge-rootlesskit` profile and creates the dedicated
`previewforge-buildkit:100000:65536` subuid/subgid ranges. The profile is loaded only through an
explicit `apparmor_parser -r /etc/apparmor.d/previewforge-rootlesskit` call. The provisioning
path deliberately does not call `aa-enforce`: on Ubuntu 24.04 hosted images that helper may scan
unrelated `passt`/`pasta` mount profiles and fail with a `runbindable` parse error even when the
PreviewForge profile is valid. The prerequisite script must pass with `--profile-test`; a mismatch
is reported as an infrastructure blocker.

Profile verification has two separate fail-closed stages:

1. `verify-apparmor-profile.sh --load` validates and loads the target profile, then checks that
   `previewforge-rootlesskit (enforce)` is present in the kernel profile set.
2. `check-prerequisites.sh --profile-test` repeats the active/enforce check using
   `/sys/kernel/security/apparmor/profiles` (with a filtered `aa-status` fallback), without
   changing any profile state.

No unrelated system profile is patched, disabled, or switched between complain and enforce mode.

The workflow never sets `kernel.apparmor_restrict_unprivileged_userns=0`, uses `--privileged`,
`apparmor=unconfined`, `seccomp=unconfined`, host networking, a Docker socket, or a BuildKit TCP
listener. A hosted image may contain a Docker daemon for unrelated actions; the prerequisite
check fails only if the dedicated BuildKit user can access that socket, and the AppArmor profile
still denies it to the rootless stack.

## Canonical topology

```text
GitHub-hosted job process (host namespace)
  |-- Unix: /var/tmp/previewforge-buildkit/buildkitd.sock
  |-- 127.0.0.1:5000 --RootlessKit builtin port-forward-->
  v
RootlessKit --net=slirp4netns --disable-host-loopback
  |-- registry 127.0.0.1:5000       (inside namespace, HTTP)
  `-- buildkitd Unix socket          (same namespace/filesystem)
          `-- pushes to 127.0.0.1:5000
```

Registry and BuildKit share one rootless namespace. The registry is not exposed on `0.0.0.0`, a
VM NIC, or a public interface. The [RootlessKit port-driver contract](https://pkg.go.dev/github.com/rootless-containers/rootlesskit/v3/pkg/port#Spec)
uses `127.0.0.1` as the builtin driver's child address.

## Explicit BuildKit registry configuration

The canonical template is [infrastructure/m4-runner/buildkitd.toml](../../infrastructure/m4-runner/buildkitd.toml):

```toml
[registry."127.0.0.1:5000"]
  http = true
```

The workflow copies it into `/var/tmp/previewforge-buildkit/buildkitd.toml` and starts:

```text
buildkitd --config /var/tmp/previewforge-buildkit/buildkitd.toml \
          --addr unix:///var/tmp/previewforge-buildkit/buildkitd.sock
```

`insecure = true` is not used. This is plain HTTP scoped to the loopback-only disposable
registry, not a trust bypass for self-signed TLS.

## Immutable tool versions

[infrastructure/m4-runner/versions.env](../../infrastructure/m4-runner/versions.env) pins the
BuildKit and Distribution registry versions, download URL, architecture, and SHA-256 checksums.
The workflow sources this manifest and uses checksum-verifying installers; it never resolves
`latest`.

## Acceptance command and evidence

The workflow runs the real test as `previewforge-buildkit` with:

```text
BUILDKIT_ADDR=unix:///var/tmp/previewforge-buildkit/buildkitd.sock
REGISTRY_URL=127.0.0.1:5000
REGISTRY_PROTOCOL=http
```

It must build and push the fixture, return an immutable `sha256:<64 hex>` digest, fetch the
manifest by that digest, verify the matching `Docker-Content-Digest`, and pass cleanup and
credential/privilege-boundary checks. M4 remains blocked until this hosted workflow succeeds.
