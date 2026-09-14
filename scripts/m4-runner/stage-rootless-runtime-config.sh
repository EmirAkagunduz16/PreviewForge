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

install -d -o "$runtime_user" -g "$runtime_user" -m 0700 "$root_dir"
install -o "$runtime_user" -g "$runtime_user" -m 0600 "$registry_source" "$registry_target"
install -o "$runtime_user" -g "$runtime_user" -m 0600 "$buildkit_source" "$buildkit_target"

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

echo "Staged rootless runtime configs under $root_dir (owner=$runtime_user mode=0600)"
if [[ "$client_group" != "$runtime_group" ]]; then
  echo "Unix socket client group: $client_group (runtime directory mode=2710)"
fi
