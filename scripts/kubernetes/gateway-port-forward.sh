#!/usr/bin/env bash
set -Eeuo pipefail

# Forward the Envoy data-plane Service generated for the platform Gateway. This
# only creates a local kubectl port-forward; it does not change cluster state.
GATEWAY_NAMESPACE="${PREVIEWFORGE_GATEWAY_NAMESPACE:-default}"
GATEWAY_NAME="${PREVIEWFORGE_GATEWAY_NAME:-previewforge}"
ENVOY_NAMESPACE="${PREVIEWFORGE_ENVOY_NAMESPACE:-envoy-gateway-system}"
LOCAL_PORT="${PREVIEWFORGE_GATEWAY_LOCAL_PORT:-18080}"
REMOTE_PORT="${PREVIEWFORGE_GATEWAY_REMOTE_PORT:-80}"
WAIT_SECONDS="${PREVIEWFORGE_GATEWAY_WAIT_SECONDS:-120}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

require_command kubectl

KUBECTL_ARGS=()
if [[ -n "${KUBE_CONTEXT:-}" ]]; then
  KUBECTL_ARGS+=(--context "$KUBE_CONTEXT")
fi

service_name=""
deadline=$((SECONDS + WAIT_SECONDS))
while (( SECONDS < deadline )); do
  mapfile -t gateway_services < <(
    kubectl "${KUBECTL_ARGS[@]}" -n "$ENVOY_NAMESPACE" get service \
      -l "gateway.envoyproxy.io/owning-gateway-name=${GATEWAY_NAME},gateway.envoyproxy.io/owning-gateway-namespace=${GATEWAY_NAMESPACE}" \
      -o name 2>/dev/null || true
  )

  if (( ${#gateway_services[@]} == 1 )); then
    service_name="${gateway_services[0]}"
    break
  fi
  if (( ${#gateway_services[@]} > 1 )); then
    echo "expected one Envoy Service for ${GATEWAY_NAMESPACE}/${GATEWAY_NAME}, found ${#gateway_services[@]}" >&2
    printf '  %s\n' "${gateway_services[@]}" >&2
    exit 1
  fi
  sleep 2
done

if [[ -z "$service_name" ]]; then
  echo "Envoy data-plane Service for ${GATEWAY_NAMESPACE}/${GATEWAY_NAME} was not found" >&2
  exit 1
fi

echo "Forwarding ${service_name} in ${ENVOY_NAMESPACE} to http://127.0.0.1:${LOCAL_PORT}"
echo "Use the preview HTTPRoute hostname in the Host header; for example:"
echo "  curl --fail --silent --show-error -H 'Host: preview-<environment-id>.previewforge.local' http://127.0.0.1:${LOCAL_PORT}/"
exec kubectl "${KUBECTL_ARGS[@]}" -n "$ENVOY_NAMESPACE" port-forward \
  --address 127.0.0.1 "$service_name" "${LOCAL_PORT}:${REMOTE_PORT}"
