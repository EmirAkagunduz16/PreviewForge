#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo 'run this script as root on the disposable Ubuntu 24.04 VM' >&2
  exit 1
fi
if [[ ! -r /etc/os-release ]]; then
  echo 'cannot identify operating system' >&2
  exit 1
fi
. /etc/os-release
if [[ "${ID:-}" != ubuntu || "${VERSION_ID:-}" != 24.04 ]]; then
  echo 'this provisioning script supports Ubuntu 24.04 only' >&2
  exit 1
fi

userns_policy="$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || true)"
if [[ "$userns_policy" != 1 ]]; then
  echo "refusing host: kernel.apparmor_restrict_unprivileged_userns must be 1, got ${userns_policy:-unavailable}" >&2
  exit 1
fi

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  apparmor apparmor-utils ca-certificates curl git jq \
  uidmap rootlesskit slirp4netns fuse-overlayfs ripgrep

if ! id previewforge-buildkit >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash previewforge-buildkit
fi
install -d -o previewforge-buildkit -g previewforge-buildkit -m 0700 /var/tmp/previewforge-buildkit

ensure_subid() {
  local file="$1"
  if ! grep -q '^previewforge-buildkit:' "$file"; then
    printf 'previewforge-buildkit:100000:65536\n' >>"$file"
  fi
}
ensure_subid /etc/subuid
ensure_subid /etc/subgid

./scripts/m4-runner/verify-apparmor-profile.sh --check

echo 'Provisioning complete. Packaged RootlessKit AppArmor profile verified without mutation.'
