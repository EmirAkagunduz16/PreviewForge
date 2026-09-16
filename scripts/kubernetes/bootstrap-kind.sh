#!/usr/bin/env bash
set -Eeuo pipefail

CLUSTER_NAME="${PREVIEWFORGE_KIND_CLUSTER:-previewforge}"
export DOCKER_CONTEXT="${PREVIEWFORGE_DOCKER_CONTEXT:-default}"
ENVOY_GATEWAY_VERSION="v1.9.1"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
KIND_CONFIG="${REPOSITORY_ROOT}/infrastructure/kubernetes/kind-config.yaml"
GATEWAY_MANIFEST="${REPOSITORY_ROOT}/infrastructure/kubernetes/platform-gateway.yaml"
ENVOY_INSTALL_URL="https://github.com/envoyproxy/gateway/releases/download/${ENVOY_GATEWAY_VERSION}/install.yaml"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

require_command docker
require_command kubectl
require_command kind

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not reachable" >&2
  exit 1
fi

if ! kind get clusters | grep -Fxq "${CLUSTER_NAME}"; then
  kind create cluster --name "${CLUSTER_NAME}" --config "${KIND_CONFIG}"
fi

kubectl cluster-info >/dev/null
kubectl apply --server-side --force-conflicts -f "${ENVOY_INSTALL_URL}"
kubectl -n envoy-gateway-system wait --for=condition=Available deployment/envoy-gateway --timeout=180s
kubectl apply --server-side --force-conflicts -f "${GATEWAY_MANIFEST}"
kubectl wait --for=condition=Accepted gatewayclass/eg --timeout=120s

echo "PreviewForge Kubernetes bootstrap is ready"
kubectl get gatewayclass/eg gateway/previewforge -n default
