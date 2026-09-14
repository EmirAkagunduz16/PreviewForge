#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo 'run this script as root on the disposable Ubuntu runner' >&2
  exit 1
fi

version="${BUILDKIT_VERSION:-}"
sha256="${BUILDKIT_TARBALL_SHA256:-}"
arch="${BUILDKIT_ARCH:-amd64}"
if [[ -z "$version" || -z "$sha256" ]]; then
  cat >&2 <<'EOF'
BUILDKIT_VERSION and BUILDKIT_TARBALL_SHA256 are required.
Choose an upstream BuildKit release and record its official checksum before running this script.
EOF
  exit 2
fi
if [[ ! "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ || ! "$sha256" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo 'invalid BuildKit version or SHA-256 checksum' >&2
  exit 2
fi
case "$arch" in
  amd64|arm64) ;;
  *) echo 'BUILDKIT_ARCH must be amd64 or arm64' >&2; exit 2 ;;
esac

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
archive="$tmp_dir/buildkit.tgz"
url="https://github.com/moby/buildkit/releases/download/${version}/buildkit-${version}.linux-${arch}.tar.gz"
curl --fail --location --proto '=https' --tlsv1.2 --output "$archive" "$url"
printf '%s  %s\n' "$sha256" "$archive" | sha256sum --check --status
tar --extract --gzip --file "$archive" --directory "$tmp_dir"
install -o root -g root -m 0755 "$tmp_dir/bin/buildkitd" /usr/local/bin/buildkitd
install -o root -g root -m 0755 "$tmp_dir/bin/buildctl" /usr/local/bin/buildctl
buildkitd --version
buildctl --version
