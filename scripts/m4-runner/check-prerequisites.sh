#!/usr/bin/env bash
set -euo pipefail

case "${1:---check}" in
  --check)
    profile_test=0
    ;;
  --profile-test)
    profile_test=1
    ;;
  *)
    printf 'usage: %s [--check|--profile-test]\n' "$0" >&2
    exit 2
    ;;
esac

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

for command_name in rootlesskit getsubids newuidmap newgidmap slirp4netns fuse-overlayfs buildkitd buildctl registry aa-status apparmor_parser dpkg-query; do
  check_command "$command_name"
done

if [[ "$(command -v rootlesskit 2>/dev/null || true)" != /usr/bin/rootlesskit ]]; then
  printf 'packaged RootlessKit executable is not canonical: expected /usr/bin/rootlesskit\n' >&2
  failures=$((failures + 1))
fi

if [[ "$profile_test" == 0 && "$(id -un)" != previewforge-buildkit ]]; then
  printf 'runner checks must execute as previewforge-buildkit\n' >&2
  failures=$((failures + 1))
fi
if [[ "$profile_test" == 1 && "$(id -u)" -ne 0 ]]; then
  printf '%s\n' '--profile-test must execute as root so AppArmor status can be inspected' >&2
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
if [[ "$sysctl_value" != 1 ]]; then
  printf 'kernel.apparmor_restrict_unprivileged_userns must be 1, got %s\n' "${sysctl_value:-unavailable}" >&2
  failures=$((failures + 1))
fi
if ! aa-status --enabled >/dev/null 2>&1; then
  printf 'AppArmor is not globally enabled\n' >&2
  failures=$((failures + 1))
fi

if [[ "$profile_test" == 1 ]]; then
  ./scripts/m4-runner/verify-apparmor-profile.sh --check || failures=$((failures + 1))
  for docker_socket in /var/run/docker.sock /run/docker.sock; do
    if [[ -S "$docker_socket" ]] && {
      sudo -u previewforge-buildkit test -r "$docker_socket" ||
        sudo -u previewforge-buildkit test -w "$docker_socket";
    }; then
      printf 'previewforge-buildkit can access Docker socket: %s\n' "$docker_socket" >&2
      failures=$((failures + 1))
    fi
  done
fi

if (( failures > 0 )); then
  exit 1
fi
printf 'M4 runner prerequisites passed\n'
