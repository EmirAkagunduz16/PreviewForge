#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo 'run this script as root on the disposable Ubuntu runner' >&2
  exit 1
fi

url="${REGISTRY_TARBALL_URL:-}"
sha256="${REGISTRY_TARBALL_SHA256:-}"
if [[ -z "$url" || -z "$sha256" ]]; then
  cat >&2 <<'EOF'
REGISTRY_TARBALL_URL and REGISTRY_TARBALL_SHA256 are required.
Choose an upstream distribution/distribution release and record its official checksum.
EOF
  exit 2
fi
if [[ ! "$url" =~ ^https://github\.com/distribution/distribution/releases/download/ ]]; then
  echo 'registry URL must be an HTTPS distribution/distribution release URL' >&2
  exit 2
fi
if [[ ! "$sha256" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo 'invalid registry SHA-256 checksum' >&2
  exit 2
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
archive="$tmp_dir/registry.tgz"
curl --fail --location --proto '=https' --tlsv1.2 --output "$archive" "$url"
printf '%s  %s\n' "$sha256" "$archive" | sha256sum --check --status
tar --extract --gzip --file "$archive" --directory "$tmp_dir"
registry_binary="$(find "$tmp_dir" -type f -name registry -perm -u+x -print -quit)"
if [[ -z "$registry_binary" ]]; then
  echo 'registry binary was not found in the verified archive' >&2
  exit 1
fi
install -o root -g root -m 0755 "$registry_binary" /usr/local/bin/registry
/usr/local/bin/registry --version
