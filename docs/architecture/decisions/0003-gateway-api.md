# ADR 0003: Kubernetes Gateway API for preview routing

Status: Accepted

## Decision

Use one platform-owned Gateway and one namespaced HTTPRoute per preview. Do not base a new deployment on ingress-nginx.

## Rationale

Kubernetes retired ingress-nginx in March 2026 and identifies Gateway API as its modern replacement. Gateway API also separates infrastructure ownership from application route ownership, which matches PreviewForge's control-plane boundary.

## Consequences

Local and cloud clusters must provide a conformant Gateway controller. Provider-specific GatewayClass configuration stays outside generated preview resources.
