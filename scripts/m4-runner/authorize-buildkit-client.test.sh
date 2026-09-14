#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
helper="$script_dir/authorize-buildkit-client.sh"
tmp_dir="$(mktemp -d)"
socket_path="$tmp_dir/buildkitd.sock"
private_file="$tmp_dir/buildkitd.toml"
state_dir="$tmp_dir/rootlesskit-state"
mock_bin="$tmp_dir/mock-bin"
mock_state="$tmp_dir/socket-metadata"
mock_stat_count="$tmp_dir/stat-count"
mock_transitioned="$tmp_dir/daemon-chown-completed"
mock_operations="$tmp_dir/operations.log"
socket_pid=''

cleanup() {
  if [[ -n "$socket_pid" ]]; then
    kill "$socket_pid" 2>/dev/null || true
    wait "$socket_pid" 2>/dev/null || true
  fi
  rm -rf -- "$tmp_dir"
}
trap cleanup EXIT

command -v python3 >/dev/null || {
  echo 'regression requires python3 to create a disposable Unix socket' >&2
  exit 1
}

mkdir -p "$mock_bin" "$state_dir"
chmod 0700 "$state_dir"
printf 'private config\n' >"$private_file"
chmod 0600 "$private_file"
printf 'previewforge-buildkit:runner:660\n' >"$mock_state"
: >"$mock_stat_count"
: >"$mock_operations"

python3 - "$socket_path" <<'PY' &
import socket
import sys

server = socket.socket(socket.AF_UNIX)
server.bind(sys.argv[1])
server.listen(1)
while True:
    connection, _ = server.accept()
    connection.close()
PY
socket_pid=$!
for _ in {1..50}; do
  [[ -S "$socket_path" ]] && break
  sleep 0.1
done
[[ -S "$socket_path" ]] || {
  echo 'failed to create disposable Unix socket' >&2
  exit 1
}

cat >"$mock_bin/id" <<'MOCK'
#!/usr/bin/env bash
if [[ "$#" -eq 1 && "$1" == '-u' ]]; then
  echo 0
  exit 0
fi
if [[ "$#" -eq 2 && "$1" == '-u' && "$2" == 'previewforge-buildkit' ]]; then
  echo 2000
  exit 0
fi
exec /usr/bin/id "$@"
MOCK

cat >"$mock_bin/getent" <<'MOCK'
#!/usr/bin/env bash
if [[ "$#" -eq 2 && "$1" == group && "$2" == runner ]]; then
  echo 'runner:x:2000:'
  exit 0
fi
exit 2
MOCK

cat >"$mock_bin/stat" <<'MOCK'
#!/usr/bin/env bash
if [[ "$#" -eq 3 && "$1" == '-c' && "$2" == '%U:%G:%a' && "$3" == "$BUILDKIT_SOCKET_MOCK" ]]; then
  count="$(<"$BUILDKIT_STAT_COUNT_MOCK")"
  if [[ "$count" -eq 0 ]]; then
    cat "$BUILDKIT_SOCKET_STATE_MOCK"
  else
    if [[ ! -e "$BUILDKIT_DAEMON_CHOWN_MOCK" ]]; then
      IFS=: read -r owner group mode <"$BUILDKIT_SOCKET_STATE_MOCK"
      printf '%s:%s:%s\n' "$owner" previewforge-buildkit "$mode" >"$BUILDKIT_SOCKET_STATE_MOCK"
      : >"$BUILDKIT_DAEMON_CHOWN_MOCK"
    fi
    cat "$BUILDKIT_SOCKET_STATE_MOCK"
  fi
  printf '%s\n' "$((count + 1))" >"$BUILDKIT_STAT_COUNT_MOCK"
  exit 0
fi
exec /usr/bin/stat "$@"
MOCK

cat >"$mock_bin/chgrp" <<'MOCK'
#!/usr/bin/env bash
[[ "$#" -eq 3 && "$1" == '--' && "$3" == "$BUILDKIT_SOCKET_MOCK" && "$2" == runner ]] || exit 1
IFS=: read -r owner _ mode <"$BUILDKIT_SOCKET_STATE_MOCK"
printf '%s:%s:%s\n' "$owner" runner "$mode" >"$BUILDKIT_SOCKET_STATE_MOCK"
printf 'chgrp %s %s\n' "$2" "$3" >>"$BUILDKIT_OPERATIONS_MOCK"
MOCK

cat >"$mock_bin/chmod" <<'MOCK'
#!/usr/bin/env bash
[[ "$#" -eq 3 && "$1" == 0660 && "$2" == '--' && "$3" == "$BUILDKIT_SOCKET_MOCK" ]] || exit 1
IFS=: read -r owner group _ <"$BUILDKIT_SOCKET_STATE_MOCK"
printf '%s:%s:660\n' "$owner" "$group" >"$BUILDKIT_SOCKET_STATE_MOCK"
printf 'chmod %s %s\n' "$1" "$3" >>"$BUILDKIT_OPERATIONS_MOCK"
MOCK

chmod 0755 "$mock_bin"/*
export BUILDKIT_CLIENT_GROUP=runner
export BUILDKIT_SOCKET_MOCK="$socket_path"
export BUILDKIT_SOCKET_STATE_MOCK="$mock_state"
export BUILDKIT_STAT_COUNT_MOCK="$mock_stat_count"
export BUILDKIT_DAEMON_CHOWN_MOCK="$mock_transitioned"
export BUILDKIT_OPERATIONS_MOCK="$mock_operations"
export PATH="$mock_bin:$PATH"

[[ "$(<"$mock_state")" == 'previewforge-buildkit:runner:660' ]] || exit 1
authorization_output="$(BUILDKIT_SOCKET="$socket_path" "$helper" 2>&1)" || {
  printf '%s\n' "$authorization_output" >&2
  exit 1
}
[[ "$authorization_output" == *'Authorized BuildKit client group runner'* ]] || exit 1
[[ -e "$mock_transitioned" ]] || {
  echo 'regression did not exercise the daemon chown readiness transition' >&2
  exit 1
}
[[ "$(<"$mock_state")" == 'previewforge-buildkit:runner:660' ]] || exit 1
[[ "$(stat -c '%a' "$private_file")" == 600 ]] || exit 1
[[ "$(stat -c '%a' "$state_dir")" == 700 ]] || exit 1
[[ "$(wc -l <"$mock_operations")" == 2 ]] || exit 1

assert_rejected() {
  local target="$1"
  local label="$2"
  if BUILDKIT_SOCKET="$target" "$helper" >"$tmp_dir/$label.log" 2>&1; then
    echo "helper unexpectedly accepted $label target" >&2
    exit 1
  fi
}

assert_rejected "$tmp_dir/missing.sock" missing
printf 'not a socket\n' >"$tmp_dir/not-a-socket"
assert_rejected "$tmp_dir/not-a-socket" regular-file
ln -s -- "$socket_path" "$tmp_dir/socket-link"
assert_rejected "$tmp_dir/socket-link" symlink

echo 'BuildKit client socket authorization regression passed'
