# System design

## Boundaries

PreviewForge is a control plane over an existing Kubernetes cluster. It owns metadata and desired state; Kubernetes owns workload runtime state. It does not create clusters and it does not accept arbitrary Kubernetes manifests.

The backend has two deployment units:

- `api`: authentication, GitHub App callbacks and webhooks, project settings, query APIs, SSE fan-out, and the transactional outbox.
- `worker`: repository acquisition, BuildKit orchestration, registry publication, Kubernetes reconciliation, health checks, cleanup, and status events.

Both may scale horizontally. They share versioned contracts but not private implementation modules.

## Source of truth

PostgreSQL stores users, GitHub installations, projects, encrypted environment variables, pull requests, desired preview environments, deployments, webhook deliveries, outbox events, consumer receipts, log chunks, and cleanup leases.

Kafka transports facts and commands between processes. A Kafka offset is not accepted as the only record that a deployment exists or changed state.

## Webhook-to-preview sequence

```text
GitHub
  | pull_request event + delivery id + HMAC
  v
API: verify raw body
  | insert webhook delivery (unique delivery id)
  | upsert PR desired SHA
  | create deployment + outbox event in one DB transaction
  v
Outbox relay -> Kafka [key = environment id]
  v
Worker: claim deployment lease
  | fetch source archive with short-lived installation token
  | discard token before build
  | rootless BuildKit build and push
  | resolve immutable image digest
  | re-check desired SHA
  | reconcile Kubernetes resources
  | health check
  v
API/relay -> SSE dashboard + GitHub check
```

The API returns a success response to GitHub after the event is durably accepted, not after a deployment finishes.

## Desired state and race handling

`PreviewEnvironment.desiredCommitSha` is the concurrency authority. Each deployment captures the SHA it was created for.

Before cloning, pushing, Kubernetes mutation, and READY publication, the worker atomically checks:

```text
deployment.commitSha == environment.desiredCommitSha
```

If false, the deployment becomes `SUPERSEDED`. Best-effort cancellation may save resources, but correctness does not depend on cancellation succeeding.

One environment may have history but only one desired deployment. Stable Kubernetes names derive from an internal environment ID, not repository or branch text.

## Delivery semantics

- GitHub webhooks: at least once; dedupe by `X-GitHub-Delivery`.
- Outbox publication: at least once; outbox rows keep publish attempts and timestamp.
- Kafka consumption: at least once; dedupe by event ID plus atomic domain guards.
- Kubernetes reconciliation: repeatable server-side apply using ownership labels.
- GitHub checks: update a stable check-run identifier stored with the deployment.

## Events

Events are versioned in the event type, validated at ingress, and contain identifiers rather than secrets. Initial events:

- `deployment.requested.v1`
- `deployment.stage-changed.v1`
- `deployment.log-appended.v1`
- `deployment.ready.v1`
- `deployment.failed.v1`
- `environment.deletion-requested.v1`
- `environment.deleted.v1`

Partition deployment events by environment ID to preserve per-preview ordering. Consumers must tolerate an event arriving after the desired SHA has changed.

## Logs

The worker emits structured records with timestamp, deployment ID, stage, stream, sequence, and redacted text. The API stores bounded chunks and fans them out over SSE. Clients resume with a cursor. Retention is finite and independent from deployment metadata retention.

## Kubernetes resource model

Each active preview namespace contains only namespaced resources:

```text
Namespace
├── ResourceQuota
├── LimitRange
├── NetworkPolicy (default deny + explicit allowances)
├── ServiceAccount (token automount disabled)
├── Secret (only when configured)
├── Deployment
├── Service
└── HTTPRoute -> shared platform Gateway
```

Every object carries platform, project, environment, deployment, and expiry labels/annotations. Cleanup deletes by internal namespace identity and verifies ownership before mutation.

## Operational invariants

- Control-plane database and Kafka are never reachable from preview namespaces.
- No platform or GitHub credential enters source archives, build contexts, image layers, preview environment variables, or logs.
- Images deploy by digest, never a mutable tag.
- `READY` requires Deployment availability and an HTTP health-check success.
- Retry policy is stage- and error-code-specific. User build failures are not blindly retried.
- Kubernetes state is periodically reconciled; webhook handling alone is not the cleanup guarantee.
