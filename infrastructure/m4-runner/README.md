# PreviewForge M4 ephemeral runner

This directory is the canonical operator runbook for the real M4 BuildKit acceptance. It is an
infrastructure prerequisite, not application behavior. The worker never changes AppArmor,
sysctl, subuid/subgid, Docker, or container-runtime policy.

The runbook uses one disposable Ubuntu 24.04 VM, one unprivileged
`previewforge-buildkit` account, and one RootlessKit network namespace shared by the registry
and BuildKit. Destroy the VM after the single workflow run.

## Final network topology

```text
GitHub Actions runner process (host namespace)
  |-- BUILDKIT_ADDR=unix:///var/tmp/previewforge-buildkit/buildkitd.sock
  |     (Unix socket shared through the VM filesystem)
  |-- REGISTRY_URL=127.0.0.1:5000
  |     (RootlessKit builtin port forward, host loopback only)
  v
RootlessKit: --net=slirp4netns --disable-host-loopback
  |  --publish 127.0.0.1:5000:5000/tcp
  |  (single isolated network namespace; no host-network mode)
  |-- registry: 127.0.0.1:5000   [inside this namespace]
  |-- buildkitd: Unix socket /var/tmp/previewforge-buildkit/buildkitd.sock
  |       |-- pushes to 127.0.0.1:5000   [same namespace]
  |       `-- executes the untrusted build rootlessly
  `-- no VM NIC, private interface, or public interface is bound
```

The registry is bound to `127.0.0.1:5000` inside the rootless namespace. RootlessKit forwards
only that port to the VM's `127.0.0.1`; `--disable-host-loopback` remains enabled, so BuildKit
cannot reach unrelated services on the host loopback. BuildKit itself has no TCP listener.

## One operator runbook

### 1. Create the disposable VM

Use a fresh Ubuntu Server 24.04 LTS (amd64) VM with at least 4 vCPU, 8 GiB RAM, and a 40 GiB
disposable disk. Permit outbound HTTPS to GitHub and the registry fixture. Do not assign a public
registry listener, and do not expose BuildKit on a VM interface. The VM must be disposable and
must not contain production credentials.

### 2. Clone the repository

```bash
sudo apt-get update
sudo apt-get install -y git ca-certificates curl
git clone https://github.com/EmirAkagunduz16/PreviewForge.git
cd PreviewForge
```

### 3. Provision the Ubuntu runner

Run as root on the VM. This installs only the required rootless tooling, creates the dedicated
account and its non-overlapping 65,536-ID range, and loads the named AppArmor profile.

```bash
sudo ./scripts/m4-runner/provision-ubuntu.sh
```

The script refuses a host with `kernel.apparmor_restrict_unprivileged_userns=0`; it never changes
that setting and never uses `--privileged`, `apparmor=unconfined`, `seccomp=unconfined`, or a
Docker socket.

### 4. Install the pinned BuildKit binary

Obtain the release URL and official SHA-256 from the BuildKit release published for the VM's
architecture. Keep both values in the acceptance evidence and do not use `latest`.

```bash
sudo BUILDKIT_VERSION=v<version> \
  BUILDKIT_TARBALL_SHA256=<official-64-hex-sha256> \
  BUILDKIT_ARCH=amd64 \
  ./scripts/m4-runner/install-buildkit-binaries.sh
```

Install the checksum-pinned rootless registry binary as well:

```bash
sudo REGISTRY_TARBALL_URL=https://github.com/distribution/distribution/releases/download/<version>/<archive>.tar.gz \
  REGISTRY_TARBALL_SHA256=<official-64-hex-sha256> \
  ./scripts/m4-runner/install-registry-binary.sh
```

Verify the complete host prerequisite before starting either process:

```bash
sudo ./scripts/m4-runner/check-prerequisites.sh --profile-test
```

### 5. Start the rootless BuildKit and registry stack

Run this as the unprivileged runner user from the repository checkout. The script copies the
registry config into the BuildKit runtime directory so the AppArmor profile needs no access to
the checkout path.

```bash
sudo -u previewforge-buildkit ./scripts/m4-runner/start-rootless-stack.sh
```

The only host-visible endpoints are the Unix socket and loopback registry described above. Check
that the registry is reachable from the host loopback before registering the runner:

```bash
curl --fail http://127.0.0.1:5000/v2/
sudo -u previewforge-buildkit buildctl \
  --addr unix:///var/tmp/previewforge-buildkit/buildkitd.sock \
  debug workers
```

### 6. Prepare the registry fixture

The stack starts an ephemeral distribution registry with delete enabled and data under
`/var/tmp/previewforge-registry`. No registry credential is needed for this loopback-only
fixture. Do not replace `127.0.0.1:5000` with a public or `0.0.0.0` address.

### 7. Install the GitHub Actions runner binary

As `previewforge-buildkit`, download the Linux amd64 runner version shown by GitHub Settings →
Actions → Runners → New self-hosted runner. Verify the SHA-256 published by GitHub before
extracting it into a fresh directory, for example `~/actions-runner`.

### 8. Obtain the one-time registration token

In the repository, open **Settings → Actions → Runners → New self-hosted runner**, select Linux
and x64, and copy the short-lived registration token from the generated commands. Never commit,
log, or put the token in a repository variable.

### 9. Register one ephemeral labelled runner

```bash
cd ~/actions-runner
./config.sh \
  --url https://github.com/EmirAkagunduz16/PreviewForge \
  --token '<one-time-registration-token>' \
  --name "previewforge-rootless-$(hostname -s)" \
  --labels previewforge-rootless \
  --ephemeral \
  --unattended
```

Run the listener in the same account and VM. The `--ephemeral` flag permits one job and then
deregisters the runner.

### 10. Set repository variables

In **Settings → Secrets and variables → Actions → Variables**, set exactly:

```text
PREVIEWFORGE_BUILDKIT_ADDR=unix:///var/tmp/previewforge-buildkit/buildkitd.sock
PREVIEWFORGE_REGISTRY_URL=127.0.0.1:5000
PREVIEWFORGE_REGISTRY_PROTOCOL=http
```

These are endpoint values, not credentials. No secret is required for the disposable loopback
registry. If a future authenticated registry is used, its short-lived credential must be
provided through BuildKit's credential mechanism and never as a workflow argument or build input.

### 11. Run the acceptance workflow

Start the runner listener, then open **Actions → M4 rootless BuildKit acceptance → Run workflow**.
The workflow must select the `previewforge-rootless` label and run:

```bash
BUILDKIT_ADDR=unix:///var/tmp/previewforge-buildkit/buildkitd.sock \
REGISTRY_URL=127.0.0.1:5000 \
REGISTRY_PROTOCOL=http \
pnpm test:acceptance:build
```

### 12. Confirm build, push, and immutable digest verification

Accept M4 evidence only when the job is green and its log shows all of the following:

- BuildKit connected through the Unix socket and built the fixture Dockerfile rootlessly.
- The image was pushed to `127.0.0.1:5000` from inside the shared namespace.
- BuildKit returned a `sha256:<64 lowercase hex>` digest.
- A registry manifest request addressed by that digest returned HTTP 200 and a matching
  `Docker-Content-Digest` header.
- The fixture context and manifest cleanup completed, and the negative credential/privilege
  boundary checks passed.

Until this workflow passes on the disposable runner, M4 remains blocked and must not be marked
complete. A local unit test or a registry-only smoke test is not M4 acceptance evidence.

### 13. Clean up the VM

After the workflow, stop the stack and verify the runner deregistered. Then destroy the VM and
its disks, including BuildKit cache, registry data, runner work directory, and temporary source
contexts.

```bash
sudo -u previewforge-buildkit ./scripts/m4-runner/stop-rootless-stack.sh
rm -rf ~/actions-runner
sudo rm -rf /var/tmp/previewforge-buildkit /var/tmp/previewforge-registry
```

Do not reuse the VM for another acceptance run without reprovisioning it from a clean image.
