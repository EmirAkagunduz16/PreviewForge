# PreviewForge M4 GitHub-hosted acceptance

This is the canonical operator runbook for the real M4 BuildKit acceptance. The workflow runs on
`ubuntu-24.04`, provisions its own disposable rootless toolchain, runs one acceptance job, and
cleans up. No self-hosted runner, external VM, registration token, or repository endpoint
variable is required.

## Hosted runner and capacity

GitHub's standard public-repository `ubuntu-24.04` runner provides a fresh 4-vCPU, 16-GB RAM,
14-GB SSD VM for each job. The M4 fixture is a tiny `FROM scratch` image, and the job deletes its
BuildKit cache, registry data, and temporary context, so the former 40-GB external-VM requirement
is not part of this acceptance path. The workflow still prints `df -h` and fails only through its
explicit prerequisite checks; a future larger fixture must be evaluated against the hosted disk
before being added.

References: [GitHub-hosted runner specifications](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
and the [Ubuntu 24.04 image inventory](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md).

## Final network topology

```text
GitHub-hosted job process (VM host namespace)
  |-- BUILDKIT_ADDR=unix:///var/tmp/previewforge-buildkit/buildkitd.sock
  |-- REGISTRY_URL=127.0.0.1:5000
  |     (RootlessKit builtin port-forward, host loopback only)
  v
RootlessKit: --net=slirp4netns --disable-host-loopback
  |  --publish 127.0.0.1:5000:5000/tcp
  |-- registry: 127.0.0.1:5000   [inside this namespace, plain HTTP]
  |-- buildkitd: Unix socket /var/tmp/previewforge-buildkit/buildkitd.sock
  |       |-- pushes to 127.0.0.1:5000 [same namespace]
  |       `-- executes the untrusted build rootlessly
  `-- no BuildKit TCP listener and no VM NIC/public bind
```

The registry is loopback-only inside the shared RootlessKit namespace. The canonical
`buildkitd.toml` contains exactly:

```toml
[registry."127.0.0.1:5000"]
  http = true
```

This is deliberate plain HTTP for an isolated disposable registry. It does not use
`insecure = true`, global AppArmor/sysctl relaxation, `--privileged`, `apparmor=unconfined`,
`seccomp=unconfined`, Docker socket mounts, or host networking. A hosted image may have Docker
installed, but the dedicated user must not be able to access its socket.

## Workflow sequence

The manually dispatched workflow is [M4 rootless BuildKit acceptance](../../.github/workflows/m4-buildkit-acceptance.yml)
and uses `runs-on: ubuntu-24.04`. It performs these steps in order:

1. Checkout the repository.
2. Verify Ubuntu 24.04, passwordless sudo, AppArmor enabled, and
   `kernel.apparmor_restrict_unprivileged_userns=1`. Any mismatch fails closed as an
   infrastructure blocker.
3. Run `sudo ./scripts/m4-runner/provision-ubuntu.sh`, which creates the dedicated
   `previewforge-buildkit` account, its subuid/subgid range, and the named AppArmor profile.
   Provisioning loads only `/etc/apparmor.d/previewforge-rootlesskit` with an explicit
   `apparmor_parser -r` call, then verifies that this target profile is active in enforce mode.
   It does not invoke `aa-enforce`, whose broad profile scan can parse unrelated hosted-image
   profiles such as `passt`/`pasta` and fail before the target profile is checked.
4. Source the immutable versions/checksums in `versions.env` and install BuildKit plus the
   Distribution registry with the checksum-verifying installers. No `latest` tag is used.
5. Run `sudo ./scripts/m4-runner/check-prerequisites.sh --profile-test`. This performs a separate
   fail-closed active/enforce check through `/sys/kernel/security/apparmor/profiles` (with an
   `aa-status` fallback) and does not mutate unrelated AppArmor profiles.
6. Stage the canonical registry and BuildKit configs with
   `sudo ./scripts/m4-runner/stage-rootless-runtime-config.sh`. The generated files live under
   `/var/tmp/previewforge-buildkit/`, are owned by `previewforge-buildkit`, and are mode `0600`.
   The same root-only boundary stages `rootlesskit-state/` for the dedicated user with mode
   `0700`. The checkout is not readable by the restricted daemon user.
7. Start the registry and BuildKit stack as `previewforge-buildkit`. The start script reads only
   the staged runtime files and fails closed when either is missing or has the wrong ownership or
   mode. It enters the named confined AppArmor profile explicitly with `aa-exec`; the profile has
   no automatic executable attachment, so it does not conflict with Ubuntu's packaged
   `/usr/bin/rootlesskit` attachment. It also pins RootlessKit's state directory to
   `/var/tmp/previewforge-buildkit/rootlesskit-state` with mode `0700`. RootlessKit therefore does
   not fall back to a random `/tmp/rootlesskit*` path outside the profile's runtime allowlist.
8. Smoke-check `http://127.0.0.1:5000/v2/` and
   `unix:///var/tmp/previewforge-buildkit/buildkitd.sock`.
9. If startup or smoke checks fail, the workflow prints filtered kernel AppArmor/rootlesskit
   records from both `journalctl -k` and `dmesg`, plus the stack log and process state. Profile
   permissions are not widened based on a smoke timeout alone.
10. Install pnpm/Node, install the locked dependencies, and run the acceptance client as the
   GitHub checkout user. The client uses only the Unix socket; the rootless daemon remains a
   separate `previewforge-buildkit` process and its environment is an explicit credential-free
   allowlist. The socket parent grants only execute access to the checkout user's primary group;
   no repository or `.git` permissions are widened.
11. Use these fixed acceptance values:

   ```text
   BUILDKIT_ADDR=unix:///var/tmp/previewforge-buildkit/buildkitd.sock
   REGISTRY_URL=127.0.0.1:5000
   REGISTRY_PROTOCOL=http
   ```

12. Run cleanup with `if: always()`, even when provisioning, smoke checks, or acceptance fails.

The workflow's only external inputs are GitHub's hosted runner and the public release URLs in the
version manifest. It does not request self-hosted registration or repository secrets.

## Acceptance evidence

M4 can be marked complete only after the hosted workflow is green and proves all of the following:

- rootless BuildKit connected through the Unix socket;
- the fixture image was pushed over plain HTTP to `127.0.0.1:5000` from the shared namespace;
- BuildKit returned an immutable `sha256:<64 lowercase hex>` digest;
- a manifest request by that digest returned HTTP 200 with a matching
  `Docker-Content-Digest` header;
- cleanup and credential/privilege-boundary assertions passed.

Until that real `ubuntu-24.04` workflow succeeds, M4 remains blocked and is not COMPLETE.
