# Initial threat model

## Trust zones

- Trusted: PreviewForge source, control-plane identities, database, Kafka, registry write credentials, Kubernetes reconciliation identity.
- Partially trusted: GitHub webhook transport after signature verification and GitHub API responses after schema validation.
- Untrusted: repository contents, Dockerfiles, build output, application containers, HTTP traffic reaching preview URLs, log text emitted by builds and workloads.

## Primary threats and controls

| Threat | Initial control |
| --- | --- |
| Forged or replayed webhook | HMAC-SHA256 over raw body, constant-time compare, unique delivery ID |
| Stale deployment overwrites current PR | desired-SHA compare-and-set before every external side effect |
| Docker socket or host escape | separate rootless BuildKit, no host Docker socket, no insecure entitlements |
| Resource exhaustion | build timeout, BuildKit limits, namespace ResourceQuota and LimitRange |
| Cross-preview traffic | default-deny NetworkPolicy with explicit DNS, Gateway, and allowed egress rules |
| Kubernetes API credential theft | `automountServiceAccountToken: false` for preview workloads |
| Secret disclosure | application encryption, write-only API, redaction, etcd encryption-at-rest requirement |
| Registry credential theft | short-lived/narrow token, never mounted into build steps or preview pods |
| Orphaned resources | owner labels, TTL, close-event cleanup, periodic reconciler |
| Malicious log content | structured transport, size/rate limits, terminal escape handling, UI text rendering |

## Explicit MVP limitation

The initial cluster is for trusted project owners and portfolio demonstration. Namespace isolation plus ordinary containers is not sufficient for arbitrary hostile tenants. Public onboarding is blocked until sandboxed runtime or stronger node/cluster isolation is designed and tested.

## Required manifest posture

- Restricted Pod Security labels on preview namespaces.
- Non-root UID, read-only root filesystem where compatible, dropped Linux capabilities, seccomp RuntimeDefault, and no privilege escalation.
- CPU/memory requests and limits plus pod/object quotas.
- No host namespaces, host paths, privileged containers, host ports, or LoadBalancer services.
- Platform Gateway is the only inbound route.
- Cluster metadata endpoints and control-plane subnets are denied from preview pods.
