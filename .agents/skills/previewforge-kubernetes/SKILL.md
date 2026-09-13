---
name: previewforge-kubernetes
description: Implement or review PreviewForge BuildKit, Kubernetes, Gateway API, registry, health-check, and preview cleanup behavior. Use when changes create or mutate build or preview infrastructure; do not use for ordinary API or dashboard work.
---

# PreviewForge Kubernetes and builds

Read `docs/architecture/system-design.md`, ADR 0003, ADR 0004, and `docs/security/threat-model.md` before changing build or runtime infrastructure.

Treat repository contents, Dockerfiles, build output, preview images, and their logs as untrusted.

## Build boundary

- Use the dedicated rootless BuildKit service. Never mount a Docker socket or enable insecure/host-network entitlements.
- Fetch private source outside the build using a short-lived GitHub installation token, then discard the token before starting BuildKit.
- Never place platform, GitHub, registry, or Kubernetes credentials in build args, the context, layers, or logs.
- Apply build time, CPU, memory, disk, and log limits. Scope shared caches to the established trust boundary.
- Persist and deploy the image digest, not a mutable tag.

## Preview resources

- Derive stable resource names from internal IDs and verify ownership labels before mutation or deletion.
- Use a namespace per preview for lifecycle, plus ResourceQuota, LimitRange, default-deny NetworkPolicy, and Restricted Pod Security labels.
- Set `automountServiceAccountToken: false`; require non-root execution, no privilege escalation, dropped capabilities, RuntimeDefault seccomp, and resource requests/limits.
- Create ClusterIP Services and HTTPRoutes that attach to the platform-owned Gateway. Do not generate LoadBalancer Services or ingress-nginx resources.
- Block cluster control-plane, metadata, database, Kafka, and registry management endpoints from preview workloads.
- Re-check desired SHA immediately before applying resources and publishing READY.

## Verification

Render and statically validate manifests, then exercise behavior against a disposable real cluster. Test repeated apply/delete, failed rollout, failed health check, supersession during rollout, TTL cleanup, and orphan reconciliation. Do not describe a manifest-only check as an end-to-end Kubernetes test.
