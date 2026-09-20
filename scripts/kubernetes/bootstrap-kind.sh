#!/usr/bin/env bash
set -Eeuo pipefail

CLUSTER_NAME="${PREVIEWFORGE_KIND_CLUSTER:-previewforge}"
export DOCKER_CONTEXT="${PREVIEWFORGE_DOCKER_CONTEXT:-default}"
KUBE_CONTEXT="${KUBE_CONTEXT:-kind-${CLUSTER_NAME}}"
ENVOY_GATEWAY_VERSION="v1.9.1"
ENVOY_GATEWAY_WAIT_SECONDS="${PREVIEWFORGE_ENVOY_GATEWAY_WAIT_SECONDS:-300}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
KIND_CONFIG="${REPOSITORY_ROOT}/infrastructure/kubernetes/kind-config.yaml"
GATEWAY_MANIFEST="${REPOSITORY_ROOT}/infrastructure/kubernetes/platform-gateway.yaml"
ENVOY_INSTALL_URL="https://github.com/envoyproxy/gateway/releases/download/${ENVOY_GATEWAY_VERSION}/install.yaml"
KIND_HTTP_HOST_PORT="${PREVIEWFORGE_KIND_HTTP_HOST_PORT:-30080}"
KIND_HTTPS_HOST_PORT="${PREVIEWFORGE_KIND_HTTPS_HOST_PORT:-30443}"

validate_port() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[0-9]+$ || "$value" -lt 1 || "$value" -gt 65535 ]]; then
    echo "${name} must be a numeric port in 1..65535" >&2
    exit 2
  fi
}

validate_port PREVIEWFORGE_KIND_HTTP_HOST_PORT "$KIND_HTTP_HOST_PORT"
validate_port PREVIEWFORGE_KIND_HTTPS_HOST_PORT "$KIND_HTTPS_HOST_PORT"
if [[ ! "$ENVOY_GATEWAY_WAIT_SECONDS" =~ ^[0-9]+$ || "$ENVOY_GATEWAY_WAIT_SECONDS" -lt 1 ]]; then
  echo 'PREVIEWFORGE_ENVOY_GATEWAY_WAIT_SECONDS must be a positive integer' >&2
  exit 2
fi

TEMP_KIND_CONFIG=""
cleanup_kind_config() {
  if [[ -n "$TEMP_KIND_CONFIG" ]]; then
    rm -f -- "$TEMP_KIND_CONFIG"
  fi
}
trap cleanup_kind_config EXIT

if [[ "$KIND_HTTP_HOST_PORT" != "30080" || "$KIND_HTTPS_HOST_PORT" != "30443" ]]; then
  umask 077
  TEMP_KIND_CONFIG="$(mktemp "${TMPDIR:-/tmp}/previewforge-kind-config.XXXXXX.yaml")"
  sed \
    -e "s/hostPort: 30080/hostPort: ${KIND_HTTP_HOST_PORT}/" \
    -e "s/hostPort: 30443/hostPort: ${KIND_HTTPS_HOST_PORT}/" \
    "$KIND_CONFIG" >"$TEMP_KIND_CONFIG"
  KIND_CONFIG="$TEMP_KIND_CONFIG"
fi

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

if [[ -n "${KUBECONFIG:-}" ]]; then
  umask 077
  kind get kubeconfig --name "${CLUSTER_NAME}" >"${KUBECONFIG}"
fi

kubectl --context "${KUBE_CONTEXT}" cluster-info >/dev/null
kubectl --context "${KUBE_CONTEXT}" apply --server-side --force-conflicts -f "${ENVOY_INSTALL_URL}"
kubectl --context "${KUBE_CONTEXT}" -n envoy-gateway-system wait --for=condition=Available deployment/envoy-gateway --timeout="${ENVOY_GATEWAY_WAIT_SECONDS}s"
kubectl --context "${KUBE_CONTEXT}" apply --server-side --force-conflicts -f "${GATEWAY_MANIFEST}"
kubectl --context "${KUBE_CONTEXT}" wait --for=condition=Accepted gatewayclass/eg --timeout=120s

echo "PreviewForge Kubernetes bootstrap is ready"
kubectl --context "${KUBE_CONTEXT}" get gatewayclass/eg gateway/previewforge -n default
