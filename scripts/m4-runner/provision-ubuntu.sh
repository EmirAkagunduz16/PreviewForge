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

if sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null | grep -qx '0'; then
  echo 'refusing a host with global apparmor_restrict_unprivileged_userns=0' >&2
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

install -D -o root -g root -m 0644 \
  infrastructure/m4-runner/apparmor/previewforge-rootlesskit \
  /etc/apparmor.d/previewforge-rootlesskit
apparmor_parser -r /etc/apparmor.d/previewforge-rootlesskit
aa-enforce previewforge-rootlesskit

echo 'Provisioning complete. Do not register the runner until check-prerequisites.sh passes.'
