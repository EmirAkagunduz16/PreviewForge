#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo 'RootlessKit namespace verification must run as root' >&2
  exit 1
fi

runtime_user='previewforge-buildkit'
state_dir="${BUILDKIT_ROOT:-/var/tmp/previewforge-buildkit}/rootlesskit-state"
child_pid_path="$state_dir/child_pid"
api_socket_path="$state_dir/api.sock"

id "$runtime_user" >/dev/null 2>&1 || {
  echo "missing runtime user: $runtime_user" >&2
  exit 1
}

child_pid=''
for _ in {1..50}; do
  if [[ -f "$child_pid_path" && -S "$api_socket_path" ]]; then
    child_pid="$(<"$child_pid_path")"
    if [[ "$child_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$child_pid" 2>/dev/null; then
      break
    fi
  fi
  child_pid=''
  sleep 0.1
done

if [[ -z "$child_pid" ]]; then
  echo 'RootlessKit child namespace did not publish a live child PID and API socket' >&2
  exit 1
fi

host_user_namespace="$(readlink /proc/1/ns/user)"
child_user_namespace="$(readlink "/proc/$child_pid/ns/user")"
if [[ "$child_user_namespace" == "$host_user_namespace" ]]; then
  echo 'RootlessKit child process is still in the host user namespace' >&2
  exit 1
fi

apparmor_label="$(<"/proc/$child_pid/attr/current")"
if [[ "$apparmor_label" != rootlesskit* ]]; then
  echo "RootlessKit child is not using the packaged per-binary AppArmor attachment: $apparmor_label" >&2
  exit 1
fi
echo "RootlessKit child namespace verified (child_pid=$child_pid profile=$apparmor_label)"

verify_id_map() {
  local map_name="$1"
  local parent_id="$2"
  local subid_path="$3"
  local map_path="/proc/$child_pid/${map_name}_map"
  local inside_id outside_id length
  local subordinate_match=0

  read -r inside_id outside_id length <"$map_path"
  if [[ "$inside_id" != 0 || "$outside_id" != "$parent_id" || "$length" != 1 ]]; then
    echo "RootlessKit $map_name map does not map container root to the dedicated user" >&2
    exit 1
  fi

  while read -r inside_id outside_id length; do
    while IFS=: read -r name start count; do
      if [[ "$name" == "$runtime_user" && "$inside_id" == 1 && "$outside_id" == "$start" && "$length" == "$count" ]]; then
        subordinate_match=1
      fi
    done <"$subid_path"
  done < <(tail -n +2 "$map_path")

  if [[ "$subordinate_match" -ne 1 ]]; then
    echo "RootlessKit $map_name map does not contain the configured subordinate ID range" >&2
    exit 1
  fi
}

verify_id_map uid "$(id -u "$runtime_user")" /etc/subuid
verify_id_map gid "$(id -g "$runtime_user")" /etc/subgid

echo "RootlessKit UID/GID maps verified (child_pid=$child_pid)"
