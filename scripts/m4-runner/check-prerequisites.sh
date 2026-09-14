#!/usr/bin/env bash
set -euo pipefail

profile_test=0
if [[ "${1:-}" == "--profile-test" ]]; then
  profile_test=1
fi

failures=0
check_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'missing command: %s\n' "$1" >&2
    failures=$((failures + 1))
  fi
}

if [[ -r /etc/os-release ]]; then
  . /etc/os-release
  if [[ "${ID:-}" != ubuntu || "${VERSION_ID:-}" != 24.04 ]]; then
    printf 'unsupported runner image: expected Ubuntu 24.04, got %s %s\n' "${ID:-unknown}" "${VERSION_ID:-unknown}" >&2
    failures=$((failures + 1))
  fi
else
  printf 'cannot identify operating system\n' >&2
  failures=$((failures + 1))
fi

for command_name in rootlesskit newuidmap newgidmap slirp4netns fuse-overlayfs buildkitd buildctl registry aa-status aa-enforce; do
  check_command "$command_name"
done

if [[ "$profile_test" == 0 && "$(id -un)" != previewforge-buildkit ]]; then
  printf 'runner checks must execute as previewforge-buildkit\n' >&2
  failures=$((failures + 1))
fi
if [[ "$profile_test" == 1 && "$(id -u)" -ne 0 ]]; then
  printf '--profile-test must execute as root so AppArmor status can be inspected\n' >&2
  failures=$((failures + 1))
fi

if ! rg -q '^previewforge-buildkit:' /etc/subuid 2>/dev/null; then
  printf 'missing previewforge-buildkit subuid range\n' >&2
  failures=$((failures + 1))
fi
if ! rg -q '^previewforge-buildkit:' /etc/subgid 2>/dev/null; then
  printf 'missing previewforge-buildkit subgid range\n' >&2
  failures=$((failures + 1))
fi

sysctl_value="$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || true)"
if [[ "$sysctl_value" == 0 ]]; then
  printf 'global apparmor_restrict_unprivileged_userns=0 is forbidden\n' >&2
  failures=$((failures + 1))
fi

if [[ "$profile_test" == 1 ]]; then
  aa-status 2>/dev/null | rg -q 'previewforge-rootlesskit' || {
    printf 'previewforge-rootlesskit AppArmor profile is not active\n' >&2
    failures=$((failures + 1))
  }
  if [[ -S /var/run/docker.sock || -S /run/docker.sock ]]; then
    printf 'Docker socket must not be present in the BuildKit trust zone\n' >&2
    failures=$((failures + 1))
  fi
fi

if (( failures > 0 )); then
  exit 1
fi
printf 'M4 runner prerequisites passed\n'
