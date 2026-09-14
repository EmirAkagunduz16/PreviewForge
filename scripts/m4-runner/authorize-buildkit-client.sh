#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo 'BuildKit client socket authorization must run as root' >&2
  exit 1
fi

runtime_user='previewforge-buildkit'
runtime_group="$runtime_user"
client_group="${BUILDKIT_CLIENT_GROUP:-}"
socket_path="${BUILDKIT_SOCKET:-/var/tmp/previewforge-buildkit/buildkitd.sock}"

[[ -n "$client_group" && "$client_group" =~ ^[A-Za-z0-9_.-]+$ ]] || {
  echo 'BUILDKIT_CLIENT_GROUP must be a non-empty system group name' >&2
  exit 2
}
[[ "$socket_path" == /* ]] || {
  echo "BuildKit socket path must be absolute: $socket_path" >&2
  exit 2
}
id -u "$runtime_user" >/dev/null 2>&1 || {
  echo "missing runtime user: $runtime_user" >&2
  exit 1
}

client_group_entry="$(getent group "$client_group" 2>/dev/null || true)"
[[ "${client_group_entry%%:*}" == "$client_group" ]] || {
  echo "missing BuildKit client group: $client_group" >&2
  exit 1
}

# BuildKit creates the socket before its listener setup finishes. Wait for its
# own rootless daemon user/group chown to complete before granting the runner
# group access, otherwise BuildKit can immediately overwrite our repair.
ready=0
for _ in {1..100}; do
  if [[ -L "$socket_path" ]]; then
    echo "BuildKit socket must not be a symlink: $socket_path" >&2
    exit 1
  fi
  [[ -e "$socket_path" ]] || {
    echo "BuildKit socket is missing: $socket_path" >&2
    exit 1
  }
  [[ -S "$socket_path" ]] || {
    echo "BuildKit target is not a Unix socket: $socket_path" >&2
    exit 1
  }
  metadata="$(stat -c '%U:%G:%a' "$socket_path" 2>/dev/null || true)"
  owner="${metadata%%:*}"
  remainder="${metadata#*:}"
  group="${remainder%%:*}"
  if [[ "$owner" == "$runtime_user" && "$group" == "$runtime_group" ]]; then
    ready=1
    break
  fi
  sleep 0.1
done

if [[ "$ready" -ne 1 ]]; then
  echo "BuildKit socket did not become a non-symlink $runtime_user:$runtime_group socket: $socket_path" >&2
  exit 1
fi

chgrp -- "$client_group" "$socket_path"
chmod 0660 -- "$socket_path"

[[ ! -L "$socket_path" && -S "$socket_path" ]] || {
  echo "BuildKit socket changed type during authorization: $socket_path" >&2
  exit 1
}
metadata="$(stat -c '%U:%G:%a' "$socket_path")"
[[ "$metadata" == "$runtime_user:$client_group:660" ]] || {
  echo "BuildKit socket authorization metadata is invalid: $metadata" >&2
  exit 1
}

echo "Authorized BuildKit client group $client_group on $socket_path (owner=$runtime_user mode=0660)"
