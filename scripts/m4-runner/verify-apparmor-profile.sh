#!/usr/bin/env bash
set -euo pipefail

profile_name='rootlesskit'
profile_path='/etc/apparmor.d/rootlesskit'
profile_set='/sys/kernel/security/apparmor/profiles'
legacy_profile_name='previewforge-rootlesskit'
legacy_profile_path="/etc/apparmor.d/${legacy_profile_name}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo 'AppArmor profile verification must run as root' >&2
  exit 1
fi

profile_is_loaded() {
  if [[ -r "$profile_set" ]] && grep -Eq "^${profile_name} \\((enforce|unconfined)\\)$" "$profile_set"; then
    return 0
  fi

  if command -v aa-status >/dev/null 2>&1; then
    local filtered
    filtered="$(
      aa-status --show=profiles \
        --filter.profiles="^${profile_name}$" 2>/dev/null || true
    )"
    if printf '%s\n' "$filtered" | sed 's/^[[:space:]]*//' | grep -Fqx "$profile_name"; then
      return 0
    fi
  fi

  return 1
}

case "${1:---check}" in
  --check)
    ;;
  *)
    echo "usage: $0 [--check]" >&2
    exit 2
    ;;
esac

command -v apparmor_parser >/dev/null 2>&1 || {
  echo 'missing command: apparmor_parser' >&2
  exit 1
}
command -v dpkg-query >/dev/null 2>&1 || {
  echo 'missing command: dpkg-query' >&2
  exit 1
}
[[ -f "$profile_path" && ! -L "$profile_path" ]] || {
  echo "missing regular packaged RootlessKit AppArmor profile: $profile_path" >&2
  exit 1
}
if [[ -e "$legacy_profile_path" ]]; then
  echo "legacy custom AppArmor profile must not be installed: $legacy_profile_path" >&2
  exit 1
fi
if ! dpkg-query --search "$profile_path" 2>/dev/null | grep -Fqx "apparmor: $profile_path"; then
  echo "RootlessKit AppArmor profile is not owned by the Ubuntu apparmor package: $profile_path" >&2
  exit 1
fi
if ! grep -Eq '^[[:space:]]*profile[[:space:]]+rootlesskit[[:space:]]+/usr/bin/rootlesskit[[:space:]]+flags=\(unconfined\)[[:space:]]*\{' "$profile_path"; then
  echo 'packaged RootlessKit profile does not use the expected per-binary unconfined attachment' >&2
  exit 1
fi
if ! grep -Eq '^[[:space:]]*userns,[[:space:]]*$' "$profile_path"; then
  echo 'packaged RootlessKit profile does not grant user namespace creation' >&2
  exit 1
fi
if ! apparmor_parser -Q -T "$profile_path" >/dev/null; then
  echo "packaged RootlessKit profile does not parse: $profile_path" >&2
  exit 1
fi
mapfile -t parsed_profile_names < <(apparmor_parser -N "$profile_path")
if [[ "${#parsed_profile_names[@]}" -ne 1 || "${parsed_profile_names[0]:-}" != "$profile_name" ]]; then
  echo 'packaged RootlessKit profile does not define exactly the expected profile name' >&2
  exit 1
fi
if [[ -r "$profile_set" ]] && grep -Eq "^${legacy_profile_name} \\(" "$profile_set"; then
  echo "legacy custom AppArmor profile is still loaded: $legacy_profile_name" >&2
  exit 1
fi
legacy_filtered="$(
  aa-status --show=profiles \
    --filter.profiles="^${legacy_profile_name}$" 2>/dev/null || true
)"
if printf '%s\n' "$legacy_filtered" | sed 's/^[[:space:]]*//' | grep -Fqx "$legacy_profile_name"; then
  echo "legacy custom AppArmor profile is still loaded: $legacy_profile_name" >&2
  exit 1
fi
if ! profile_is_loaded; then
  echo "packaged RootlessKit AppArmor profile is not loaded: $profile_name" >&2
  if [[ -r "$profile_set" ]]; then
    grep -F "$profile_name" "$profile_set" >&2 || true
  fi
  exit 1
fi

echo 'Packaged RootlessKit AppArmor profile is present, loaded, and userns-capable'
