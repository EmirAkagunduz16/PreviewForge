# PreviewForge M4 ephemeral runner

This directory describes the disposable Ubuntu runner used by the M4 acceptance workflow. It is
not executed by the application or worker, and it must not be run against a developer laptop.
Create a fresh VM, run the scripts as root, register the runner, execute one workflow, then
destroy the VM and its disks.

## Supported base image

- Ubuntu Server 24.04 LTS (amd64) is the reference image.
- A clean ephemeral VM with at least 4 vCPU, 8 GiB RAM, 40 GiB disposable disk, and private
  network access to the registry and GitHub is required.
- The runner account is `previewforge-buildkit`; it is not an administrator and receives only a
  dedicated 65,536-ID subuid/subgid range.

## Provisioning

From a fresh VM, copy this repository and run:

```bash
sudo ./scripts/m4-runner/provision-ubuntu.sh
sudo BUILDKIT_VERSION=v<version> BUILDKIT_TARBALL_SHA256=<official-64-hex-sha256> \
  ./scripts/m4-runner/install-buildkit-binaries.sh
sudo -u previewforge-buildkit ./scripts/m4-runner/check-prerequisites.sh
```

`provision-ubuntu.sh` installs only `uidmap`, `rootlesskit`, `slirp4netns`, `fuse-overlayfs`,
AppArmor tooling, and runner prerequisites; adds an idempotent `/etc/subuid` and `/etc/subgid`
range; installs the named AppArmor profile; and refuses to change
`kernel.apparmor_restrict_unprivileged_userns`. It never uses `--privileged`,
`apparmor=unconfined`, or `seccomp=unconfined`.

Install BuildKit binaries separately from an upstream release with an operator-recorded checksum:

```bash
sudo BUILDKIT_VERSION=v<version> \
  BUILDKIT_TARBALL_SHA256=<official-64-hex-sha256> \
  BUILDKIT_ARCH=amd64 \
  ./scripts/m4-runner/install-buildkit-binaries.sh
```

The version and checksum are deliberately explicit inputs; the script never follows a mutable
`latest` URL or trusts an unverified archive. The OCI image digest in `buildkit-image.env` remains
the reference for containerized daemon deployments; do not mix a binary version and image digest
without recording both in the runner evidence.

The profile is intentionally installed only on this disposable VM. Review and negative-test it
against the exact Ubuntu kernel before registration:

```bash
sudo aa-status
sudo aa-enforce previewforge-rootlesskit
sudo ./scripts/m4-runner/check-prerequisites.sh --profile-test
```

## Runner registration

Registration requires a short-lived GitHub runner token. Do not put it in the repository or pass
it to the worker. An operator with repository administration rights must obtain the token from
GitHub Settings → Actions → Runners → New self-hosted runner, then run the downloaded GitHub
runner `config.sh` on the VM:

```bash
sudo -u previewforge-buildkit ./config.sh \
  --url https://github.com/EmirAkagunduz16/PreviewForge \
  --token '<one-time-token>' \
  --name "previewforge-rootless-$(hostname -s)" \
  --labels previewforge-rootless \
  --ephemeral \
  --unattended
```

The token is external credential material and must be supplied interactively by the operator.
The `--ephemeral` flag ensures the runner accepts one job and deregisters automatically.

## BuildKit and registry

Use the pinned BuildKit image digest in `buildkit-image.env`. Start the rootless daemon as the
dedicated runner account on a private endpoint. Do not mount the Docker socket and do not grant
privileged or insecure BuildKit entitlements. Configure the local TLS registry endpoint and set
these GitHub repository variables (not secrets):

```text
PREVIEWFORGE_BUILDKIT_ADDR=tcp://<private-runner-address>:1234
PREVIEWFORGE_REGISTRY_URL=<private-registry-host>:5000
```

The registry must be reachable from BuildKit and the worker test. If registry authentication is
needed, provide it through the BuildKit credential mechanism only; never put credentials in
workflow arguments, Dockerfiles, or logs.

## Acceptance and teardown

Run the manually dispatched `M4 rootless BuildKit acceptance` workflow. It must prove build,
push, manifest lookup by returned `sha256:` digest, digest equality, cleanup, and the negative
credential/privilege boundary. After the job, verify the runner is deregistered and destroy the
VM, BuildKit cache, temporary context, and registry fixture.
