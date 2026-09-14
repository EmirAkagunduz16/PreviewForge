# M4 rootless BuildKit runner prerequisite

This is an infrastructure prerequisite, not application behavior. The worker must never alter
kernel, AppArmor, subuid/subgid, Docker, or container-runtime policy at startup.

## Preferred runner

Run M4 build acceptance on an ephemeral Ubuntu runner or a dedicated disposable VM with:

- `uidmap` (`newuidmap` and `newgidmap`), `rootlesskit`, `slirp4netns`, and `fuse-overlayfs`;
- a dedicated unprivileged runner account (for example `previewforge-buildkit`);
- `/etc/subuid` and `/etc/subgid` entries for only that account, with a dedicated range of at
  least 65,536 IDs, for example:

  ```text
  previewforge-buildkit:100000:65536
  ```

- a rootless BuildKit daemon pinned by image digest, reachable only on the runner's private
  network;
- an OCI registry endpoint reachable from that daemon, preferably TLS-enabled even on CI;
- automatic VM/container teardown after the acceptance job.

The range must not overlap another service's allocation. The runner image and the exact range
are infrastructure configuration and must be recorded by CI, never inferred by the worker.

## AppArmor policy

Do not set `kernel.apparmor_restrict_unprivileged_userns=0` globally. Do not use
`--privileged`, `apparmor=unconfined`, or `seccomp=unconfined` as a shortcut.

Install and load a named AppArmor profile scoped to the rootlesskit/BuildKit runner on the
ephemeral runner only. The profile must explicitly mediate the user namespace operation (`userns`
rule), permit only the BuildKit rootless binary and its child runtime paths, and deny access to
Docker sockets, host credentials, unrelated host paths, and platform control-plane sockets. The
profile must be reviewed with the runner image and exercised by a negative test before acceptance.

The exact profile is distro/kernel/container-runtime dependent. A profile that needs broad
unconfined mediation is not an acceptable M4 prerequisite; use a disposable runner image and
tighten the rule set until the BuildKit smoke and the privilege-denial tests both pass.

## BuildKit launch contract

- Pin `moby/buildkit` by a multi-architecture digest, not `:latest`.
- Expose only the private BuildKit endpoint required by the worker; never mount
  `/var/run/docker.sock`.
- Do not enable insecure or privileged BuildKit entitlements.
- Configure explicit CPU, memory, disk, wall-time, and log limits at the runner/daemon boundary.
- Provide registry credentials through the BuildKit credential mechanism only when required;
  never put them in Dockerfile args, source context, image layers, or worker logs.
- Tear down the daemon and delete its temporary cache/context after the job.

## Acceptance gate

The gate is blocked until the runner can execute the real test:

```text
BUILDKIT_ADDR=<private endpoint> REGISTRY_URL=<registry host> REGISTRY_PROTOCOL=https pnpm test:acceptance:build
```

The test must build a fixture Dockerfile, push it, read the registry manifest by the returned
`sha256:` digest, assert the registry's `Docker-Content-Digest` matches, and delete the fixture
manifest. It must also include a negative privilege/credential-boundary case. A local host that
only passes after changing the global kernel sysctl is not valid evidence.

The repository provides [the manual M4 workflow](../../.github/workflows/m4-buildkit-acceptance.yml)
for an ephemeral runner labeled `previewforge-rootless`. Configure only the private endpoint
values as runner/environment variables (`PREVIEWFORGE_BUILDKIT_ADDR` and
`PREVIEWFORGE_REGISTRY_URL`); do not place credentials in workflow arguments or logs.
