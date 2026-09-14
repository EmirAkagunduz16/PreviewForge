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

Ubuntu 24.04 also ships `/etc/apparmor.d/rootlesskit` as a per-binary
`flags=(unconfined) { userns, }` profile. PreviewForge does not replace or edit that system profile
and does not adopt its unconfined trade-off. The custom confined profile intentionally has no
automatic `/usr/bin/rootlesskit` attachment; the start script enters it explicitly with:

```text
aa-exec -p previewforge-rootlesskit -- rootlesskit ...
```

This avoids competing executable attachments while retaining the custom capability, path, socket,
and credential-deny rules throughout RootlessKit's namespace setup and child processes.

The workflow never sets `kernel.apparmor_restrict_unprivileged_userns=0`, uses `--privileged`,
`apparmor=unconfined`, `seccomp=unconfined`, host networking, a Docker socket, or a BuildKit TCP
listener. A hosted image may contain a Docker daemon for unrelated actions; the prerequisite
check fails only if the dedicated BuildKit user can access that socket, and the AppArmor profile
still denies it to the rootless stack.

## Runtime configuration and client access boundary

GitHub checkout files are not assumed to be readable by the restricted daemon user. Before the
stack starts, the root-only staging step copies the two canonical repository templates into:

```text
/var/tmp/previewforge-buildkit/registry-config.yml
/var/tmp/previewforge-buildkit/buildkitd.toml
```

Both generated files are owned by `previewforge-buildkit:previewforge-buildkit` with mode `0600`.
`start-rootless-stack.sh` reads only those staged paths; it never falls back to the checkout and
fails closed if either artifact is absent or has different ownership/mode. The source templates
remain unchanged in the repository.

RootlessKit's state directory is explicitly
`/var/tmp/previewforge-buildkit/rootlesskit-state` and is owned by the dedicated user with mode
`0700`. The root-only staging step creates it before privilege drop; the start script rejects a
missing directory, symlink, or ownership/mode mismatch. Without `--state-dir`, RootlessKit creates
a random `/tmp/rootlesskit*` directory; that fallback is intentionally unavailable to the confined
profile. Keeping the state under the existing runtime allowlist avoids adding broad `/tmp` write
access and keeps RootlessKit's API socket and namespace metadata inaccessible to the workflow
client.

The daemon stays rootless, while the BuildKit test client runs as the normal GitHub checkout user
so it can read `node_modules` and the test source without broadening repository or `.git`
permissions. The runtime directory is setgid with execute-only access for that user's primary
group, allowing access to the Unix socket but not directory listing or staged-config reads. The
daemon/rootlesskit environment is constructed with an explicit allowlist containing only runtime
paths, `PATH`, locale, and `HOME`; GitHub, platform, database, and registry credentials are not
inherited. The client adapter independently scrubs its `buildctl` child environment.

## Canonical topology

```text
GitHub-hosted job process (host namespace)
  |-- Unix: /var/tmp/previewforge-buildkit/buildkitd.sock
  |-- 127.0.0.1:5000 --RootlessKit builtin port-forward-->
  v
RootlessKit --net=slirp4netns --disable-host-loopback
  |  --state-dir=/var/tmp/previewforge-buildkit/rootlesskit-state
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
