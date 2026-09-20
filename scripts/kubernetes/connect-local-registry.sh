#!/usr/bin/env bash
set -Eeuo pipefail

# Connect the existing PreviewForge development registry to disposable kind
# nodes. This is deliberately fail-closed: it never creates or substitutes a
# registry, and it never changes a non-PreviewForge Docker network.
CLUSTER_NAME="${PREVIEWFORGE_KIND_CLUSTER:-previewforge}"
export DOCKER_CONTEXT="${PREVIEWFORGE_DOCKER_CONTEXT:-default}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
REGISTRY_CONTAINER="previewforge-registry-1"
REGISTRY_NETWORK="previewforge_default"
KIND_NETWORK="kind"
REGISTRY_PORT="${PREVIEWFORGE_REGISTRY_LOCAL_PORT:-55000}"
if [[ ! "$REGISTRY_PORT" =~ ^[0-9]+$ || "$REGISTRY_PORT" -lt 1 || "$REGISTRY_PORT" -gt 65535 ]]; then
  echo 'PREVIEWFORGE_REGISTRY_LOCAL_PORT must be a numeric port in 1..65535' >&2
  exit 2
fi
REGISTRY_HOST="localhost:${REGISTRY_PORT}"
REGISTRY_ENDPOINT="http://${REGISTRY_CONTAINER}:5000"
HOSTS_DIR="/etc/containerd/certs.d/${REGISTRY_HOST}"
HOSTS_ASSET="${REPOSITORY_ROOT}/infrastructure/kubernetes/local-registry-hosts.toml"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

require_command docker
require_command kind

if [[ ! -r "$HOSTS_ASSET" ]]; then
  echo "registry hosts asset is missing or unreadable: ${HOSTS_ASSET}" >&2
  exit 1
fi

if ! kind get clusters | grep -Fxq "$CLUSTER_NAME"; then
  echo "kind cluster is not present: ${CLUSTER_NAME}" >&2
  exit 1
fi

if [[ "$(docker inspect -f '{{.Name}}' "$REGISTRY_CONTAINER" 2>/dev/null || true)" != "/${REGISTRY_CONTAINER}" ]]; then
  echo "required registry container is missing: ${REGISTRY_CONTAINER}" >&2
  exit 1
fi
if [[ "$(docker inspect -f '{{.State.Running}}' "$REGISTRY_CONTAINER")" != "true" ]]; then
  echo "required registry container is not running: ${REGISTRY_CONTAINER}" >&2
  exit 1
fi
if ! docker port "$REGISTRY_CONTAINER" 5000/tcp 2>/dev/null |
  grep -Eq "(^|:)${REGISTRY_PORT}$"; then
  echo "required registry host port mapping is missing: ${REGISTRY_HOST} -> ${REGISTRY_CONTAINER}:5000" >&2
  exit 1
fi

if ! docker network inspect "$REGISTRY_NETWORK" >/dev/null 2>&1; then
  echo "required registry network is missing: ${REGISTRY_NETWORK}" >&2
  exit 1
fi
if ! docker network inspect "$REGISTRY_NETWORK" --format '{{range .Containers}}{{println .Name}}{{end}}' |
  grep -Fxq "$REGISTRY_CONTAINER"; then
  echo "registry is not attached to its exact network: ${REGISTRY_NETWORK}" >&2
  exit 1
fi
if ! docker network inspect "$KIND_NETWORK" >/dev/null 2>&1; then
  echo "required kind network is missing: ${KIND_NETWORK}" >&2
  exit 1
fi

mapfile -t kind_nodes < <(kind get nodes --name "$CLUSTER_NAME")
if (( ${#kind_nodes[@]} == 0 )); then
  echo "no nodes found for kind cluster: ${CLUSTER_NAME}" >&2
  exit 1
fi

if ! docker network inspect "$KIND_NETWORK" --format '{{range .Containers}}{{println .Name}}{{end}}' |
  grep -Fxq "$REGISTRY_CONTAINER"; then
  docker network connect "$KIND_NETWORK" "$REGISTRY_CONTAINER"
fi

for node in "${kind_nodes[@]}"; do
  docker exec "$node" mkdir -p "$HOSTS_DIR"
  docker cp "$HOSTS_ASSET" "${node}:${HOSTS_DIR}/hosts.toml"
done

echo "Configured ${REGISTRY_HOST} -> ${REGISTRY_ENDPOINT} for ${#kind_nodes[@]} kind node(s) in ${CLUSTER_NAME}"
