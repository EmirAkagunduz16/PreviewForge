#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo 'runtime config staging must run as root' >&2
  exit 1
fi

runtime_user='previewforge-buildkit'
runtime_group="$runtime_user"
client_group="${BUILDKIT_CLIENT_GROUP:-$runtime_group}"
root_dir="${BUILDKIT_ROOT:-/var/tmp/previewforge-buildkit}"
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
registry_source="$repo_dir/infrastructure/m4-runner/registry/config.yml"
buildkit_source="$repo_dir/infrastructure/m4-runner/buildkitd.toml"
registry_target="$root_dir/registry-config.yml"
buildkit_target="$root_dir/buildkitd.toml"
state_target="$root_dir/rootlesskit-state"
buildkit_registry_host="${PREVIEWFORGE_BUILDKIT_REGISTRY_HOST:-}"

[[ "$client_group" =~ ^[A-Za-z0-9_.-]+$ ]] || {
  echo 'BUILDKIT_CLIENT_GROUP contains unsupported characters' >&2
  exit 2
}
id "$runtime_user" >/dev/null 2>&1 || {
  echo "missing runtime user: $runtime_user" >&2
  exit 1
}
getent group "$client_group" >/dev/null || {
  echo "missing BuildKit client group: $client_group" >&2
  exit 1
}
[[ -f "$registry_source" ]] || {
  echo "missing canonical registry config: $registry_source" >&2
  exit 1
}
[[ -f "$buildkit_source" ]] || {
  echo "missing canonical BuildKit config: $buildkit_source" >&2
  exit 1
}
if [[ -n "$buildkit_registry_host" && ! "$buildkit_registry_host" =~ ^[A-Za-z0-9_.-]+:[0-9]+$ ]]; then
  echo 'PREVIEWFORGE_BUILDKIT_REGISTRY_HOST must be a host:port value' >&2
  exit 2
fi

install -d -o "$runtime_user" -g "$runtime_user" -m 0700 "$root_dir"
install -o "$runtime_user" -g "$runtime_user" -m 0600 "$registry_source" "$registry_target"
if [[ -z "$buildkit_registry_host" || "$buildkit_registry_host" == '127.0.0.1:5000' ||
  "$buildkit_registry_host" == 'localhost:5000' ]]; then
  install -o "$runtime_user" -g "$runtime_user" -m 0600 "$buildkit_source" "$buildkit_target"
else
  staged_buildkit_config="$(mktemp)"
  trap 'rm -f "$staged_buildkit_config"' EXIT
  cat "$buildkit_source" >"$staged_buildkit_config"
  if ! grep -Fq "[registry.\"$buildkit_registry_host\"]" "$staged_buildkit_config"; then
    printf '\n[registry."%s"]\n  http = true\n' "$buildkit_registry_host" >>"$staged_buildkit_config"
  fi
  install -o "$runtime_user" -g "$runtime_user" -m 0600 "$staged_buildkit_config" "$buildkit_target"
  rm -f "$staged_buildkit_config"
  trap - EXIT
fi
[[ ! -L "$state_target" ]] || {
  echo "RootlessKit state directory must not be a symlink: $state_target" >&2
  exit 1
}
if [[ -e "$state_target" && ! -d "$state_target" ]]; then
  echo "RootlessKit state path is not a directory: $state_target" >&2
  exit 1
fi
install -d -o "$runtime_user" -g "$runtime_user" -m 0700 "$state_target"
# RootlessKit may remap ownership when its child namespace exits. Reassert the
# dedicated host identity before validating the boundary for the next launch.
chown "$runtime_user:$runtime_group" "$state_target"
chmod 0700 "$state_target"

if [[ "$client_group" == "$runtime_group" ]]; then
  chmod 0700 "$root_dir"
else
  # The runner group receives execute-only access to reach the Unix socket. The
  # staged configs remain 0600 and the BuildKit cache/log files are not listed.
  chown "$runtime_user:$client_group" "$root_dir"
  chmod 2710 "$root_dir"
fi

for config in "$registry_target" "$buildkit_target"; do
  [[ ! -L "$config" ]] || {
    echo "runtime config must not be a symlink: $config" >&2
    exit 1
  }
  [[ "$(stat -c '%U:%G:%a' "$config")" == "$runtime_user:$runtime_group:600" ]] || {
    echo "runtime config ownership/mode is invalid: $config" >&2
    exit 1
  }
done
[[ "$(stat -c '%U:%G:%a' "$state_target")" == "$runtime_user:$runtime_group:700" ]] || {
  echo "RootlessKit state directory ownership/mode is invalid: $state_target" >&2
  exit 1
}

echo "Staged rootless runtime configs under $root_dir (owner=$runtime_user mode=0600)"
if [[ "$client_group" != "$runtime_group" ]]; then
  echo "Unix socket client group: $client_group (runtime directory mode=2710)"
fi
