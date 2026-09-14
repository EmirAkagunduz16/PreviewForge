#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -un)" != previewforge-buildkit ]]; then
  echo 'run this script as previewforge-buildkit' >&2
  exit 1
fi
command -v rootlesskit >/dev/null
command -v buildkitd >/dev/null
command -v registry >/dev/null

root_dir="${BUILDKIT_ROOT:-/var/tmp/previewforge-buildkit}"
registry_config="${root_dir}/registry-config.yml"
buildkit_config="${root_dir}/buildkitd.toml"
socket_path="${BUILDKIT_SOCKET:-${root_dir}/buildkitd.sock}"
log_path="${BUILDKIT_LOG:-${root_dir}/rootless-stack.log}"
pid_path="${BUILDKIT_PID:-${root_dir}/rootless-stack.pid}"
if [[ ! -r "$registry_config" ]]; then
  echo "registry config is not readable: $registry_config" >&2
  exit 1
fi
if [[ ! -r "$buildkit_config" ]]; then
  echo "BuildKit config is not readable: $buildkit_config" >&2
  exit 1
fi
if [[ -e "$socket_path" ]]; then
  echo "BuildKit socket already exists: $socket_path" >&2
  exit 1
fi
if [[ "$(stat -c '%U:%G:%a' "$registry_config")" != 'previewforge-buildkit:previewforge-buildkit:600' ||
  "$(stat -c '%U:%G:%a' "$buildkit_config")" != 'previewforge-buildkit:previewforge-buildkit:600' ]]; then
  echo 'runtime configs must be owned by previewforge-buildkit with mode 0600' >&2
  exit 1
fi
mkdir -p "$(dirname "$socket_path")" "$(dirname "$log_path")"
umask 0007

# Export only the paths needed by the child shell. The registry and BuildKit
# share one slirp4netns namespace; no host-network endpoint is created.
export REGISTRY_CONFIG="$registry_config"
export BUILDKIT_CONFIG="$buildkit_config"
export BUILDKIT_SOCKET="$socket_path"
export BUILDKIT_ROOT="$root_dir"

# Registry and BuildKit share one slirp4netns namespace. RootlessKit forwards
# only the registry port to host loopback; host loopback is otherwise disabled.
clean_env=(
  "HOME=/home/previewforge-buildkit"
  'LANG=C.UTF-8'
  'LOGNAME=previewforge-buildkit'
  'PATH=/usr/local/bin:/usr/bin:/bin'
  'TMPDIR=/tmp'
  'USER=previewforge-buildkit'
  "REGISTRY_CONFIG=$registry_config"
  "BUILDKIT_CONFIG=$buildkit_config"
  "BUILDKIT_SOCKET=$socket_path"
  "BUILDKIT_ROOT=$root_dir"
)
env -i "${clean_env[@]}" nohup rootlesskit \
  --net=slirp4netns \
  --disable-host-loopback \
  --copy-up=/etc \
  --copy-up=/run \
  --port-driver=builtin \
  --publish 127.0.0.1:5000:5000/tcp \
  sh -c '
    /usr/local/bin/registry serve "$REGISTRY_CONFIG" &
    registry_pid=$!
    trap "kill $registry_pid 2>/dev/null || true; wait $registry_pid 2>/dev/null || true" EXIT INT TERM
    exec /usr/local/bin/buildkitd \
      --config "$BUILDKIT_CONFIG" \
      --addr "unix://$BUILDKIT_SOCKET" \
      --root "$BUILDKIT_ROOT"
  ' \
  >"$log_path" 2>&1 &
echo $! >"$pid_path"
echo "rootless BuildKit + registry started; socket=$socket_path registry=127.0.0.1:5000"
