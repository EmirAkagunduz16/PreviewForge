# M4 rootless BuildKit runner prerequisite

This is an infrastructure prerequisite, not application behavior. The worker must never alter
kernel, AppArmor, subuid/subgid, Docker, or container-runtime policy. The complete operator
procedure is [the M4 runner runbook](../../infrastructure/m4-runner/README.md).

## Required runner

Use a fresh, disposable Ubuntu Server 24.04 LTS (amd64) VM with at least 4 vCPU, 8 GiB RAM,
and a 40 GiB disk. Install `uidmap` (`newuidmap`/`newgidmap`), `rootlesskit`, `slirp4netns`,
`fuse-overlayfs`, checksum-pinned BuildKit and registry binaries, and a dedicated unprivileged
`previewforge-buildkit` account with a non-overlapping range such as:

```text
previewforge-buildkit:100000:65536
```

The supplied provisioning and prerequisite scripts are intended for this disposable VM only.
They reject a global `kernel.apparmor_restrict_unprivileged_userns=0` and never use
`--privileged`, `apparmor=unconfined`, `seccomp=unconfined`, host networking, or a Docker socket.

## Canonical network topology

```text
runner process (VM host namespace)
  |-- Unix: /var/tmp/previewforge-buildkit/buildkitd.sock
  |-- 127.0.0.1:5000 --RootlessKit builtin port forward-->
  v
RootlessKit --net=slirp4netns --disable-host-loopback
  |-- registry 127.0.0.1:5000       (inside this namespace)
  `-- buildkitd Unix socket          (same namespace/filesystem)
          `-- pushes to 127.0.0.1:5000
```

The registry listens only on loopback **inside** the RootlessKit namespace. RootlessKit forwards
only `127.0.0.1:5000:5000/tcp` to the VM's loopback. It is not bound to `0.0.0.0`, a VM
private interface, or a public interface. `--disable-host-loopback` stays enabled, preventing
BuildKit from reaching unrelated host-loopback services. BuildKit has no TCP listener; the
runner uses the Unix socket.

This is consistent with RootlessKit's upstream port-driver contract: the builtin driver forwards
namespace ports to the parent, and its default child address is `127.0.0.1` ([port API](https://pkg.go.dev/github.com/rootless-containers/rootlesskit/v3/pkg/port#Spec)).

Therefore the acceptance endpoints are fixed:

```text
BuildKit -> registry: 127.0.0.1:5000 (inside the shared rootless namespace)
runner -> BuildKit:    unix:///var/tmp/previewforge-buildkit/buildkitd.sock
runner -> registry:    http://127.0.0.1:5000 (RootlessKit loopback forward)
```

## AppArmor boundary

Load the named `previewforge-rootlesskit` profile on the ephemeral runner and test it against
the exact Ubuntu kernel. It permits only the rootless runtime, BuildKit, the registry binary,
their required runtime paths, and the dedicated temporary directories. It denies Docker sockets,
host credentials, and unrelated platform paths. The profile is not a replacement for the VM
boundary and must not be broadened to an unconfined profile.

## BuildKit and registry launch contract

The runbook installs release binaries with explicit version and SHA-256 inputs. The stack launcher
starts both processes under one RootlessKit invocation:

```bash
sudo -u previewforge-buildkit ./scripts/m4-runner/start-rootless-stack.sh
```

The launcher uses:

```text
rootlesskit --net=slirp4netns --disable-host-loopback \
  --port-driver=builtin --publish 127.0.0.1:5000:5000/tcp
```

The registry config binds `127.0.0.1:5000` inside that namespace. BuildKit is started with
`--config /var/tmp/previewforge-buildkit/buildkitd.toml` and
`--addr unix:///var/tmp/previewforge-buildkit/buildkitd.sock`. The canonical config contains
only:

```toml
[registry."127.0.0.1:5000"]
  http = true
```

This explicitly selects plain HTTP for the loopback-only disposable registry. It does not use
`insecure = true`, and it does not enable any insecure BuildKit entitlement.

## Repository variables

Set these GitHub repository **variables** for the manual workflow:

```text
PREVIEWFORGE_BUILDKIT_ADDR=unix:///var/tmp/previewforge-buildkit/buildkitd.sock
PREVIEWFORGE_REGISTRY_URL=127.0.0.1:5000
PREVIEWFORGE_REGISTRY_PROTOCOL=http
```

They are endpoint values, not credentials. The disposable loopback registry needs no secret.

## Acceptance gate

Run the manually dispatched [M4 rootless BuildKit workflow](../../.github/workflows/m4-buildkit-acceptance.yml)
on the one-time `previewforge-rootless` ephemeral runner. The equivalent command is:

```bash
BUILDKIT_ADDR=unix:///var/tmp/previewforge-buildkit/buildkitd.sock \
REGISTRY_URL=127.0.0.1:5000 \
REGISTRY_PROTOCOL=http \
pnpm test:acceptance:build
```

The test must build and push a fixture, return an immutable `sha256:<64 hex>` digest, fetch the
manifest by that digest, and verify a matching `Docker-Content-Digest`. It must also clean the
fixture and exercise the credential/privilege boundary. Until the real workflow passes on the
disposable runner, M4 remains blocked and no completion claim is valid.
