#!/usr/bin/env bash
set -euo pipefail

profile_name='previewforge-rootlesskit'
profile_path="/etc/apparmor.d/${profile_name}"
profile_set='/sys/kernel/security/apparmor/profiles'

if [[ "$(id -u)" -ne 0 ]]; then
  echo 'AppArmor profile verification must run as root' >&2
  exit 1
fi

profile_is_enforced() {
  if [[ -r "$profile_set" ]] && grep -Fqx "${profile_name} (enforce)" "$profile_set"; then
    return 0
  fi

  if command -v aa-status >/dev/null 2>&1; then
    local filtered
    filtered="$(
      aa-status --show=profiles \
        --filter.mode='^enforce$' \
        --filter.profiles="^${profile_name}$" 2>/dev/null || true
    )"
    if printf '%s\n' "$filtered" | sed 's/^[[:space:]]*//' | grep -Fqx "$profile_name"; then
      return 0
    fi
  fi

  return 1
}

case "${1:---check}" in
  --load)
    command -v apparmor_parser >/dev/null 2>&1 || {
      echo 'missing command: apparmor_parser' >&2
      exit 1
    }
    [[ -r "$profile_path" ]] || {
      echo "missing installed AppArmor profile: $profile_path" >&2
      exit 1
    }
    echo "Loading AppArmor profile explicitly: $profile_name"
    if ! apparmor_parser -r "$profile_path"; then
      echo "AppArmor profile syntax/load failed: $profile_name" >&2
      exit 1
    fi
    ;;
  --check)
    ;;
  *)
    echo "usage: $0 [--load|--check]" >&2
    exit 2
    ;;
esac

if ! profile_is_enforced; then
  echo "AppArmor profile is not active in enforce mode: $profile_name" >&2
  if [[ -r "$profile_set" ]]; then
    grep -F "$profile_name" "$profile_set" >&2 || true
  fi
  exit 1
fi

echo "AppArmor profile active in enforce mode: $profile_name"
