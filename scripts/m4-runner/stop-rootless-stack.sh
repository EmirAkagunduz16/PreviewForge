#!/usr/bin/env bash
set -euo pipefail

root_dir="${BUILDKIT_ROOT:-/var/tmp/previewforge-buildkit}"
pid_path="${BUILDKIT_PID:-${root_dir}/rootless-stack.pid}"
if [[ -r "$pid_path" ]]; then
  pid="$(cat "$pid_path")"
  kill "$pid" 2>/dev/null || true
  for _ in {1..50}; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  kill -KILL "$pid" 2>/dev/null || true
  rm -f "$pid_path"
fi
rm -f "${BUILDKIT_SOCKET:-${root_dir}/buildkitd.sock}" "$root_dir/registry-config.yml" "$root_dir/buildkitd.toml"
