# Foundation research

Date: 2026-09-12

This note validates the initial PreviewForge proposal against current primary documentation. It records decisions, not a general tutorial.

## Conclusions

### Keep the product narrow

The proposed single-container, Dockerfile-only, GitHub-only MVP is credible. The hard engineering work is already in webhook correctness, untrusted builds, desired-state reconciliation, and Kubernetes workload isolation. Multi-container apps, production deployments, database provisioning, and cluster provisioning would dilute that story.

### Use Gateway API, not ingress-nginx

Kubernetes retired ingress-nginx in March 2026 and recommends migration to Gateway API or another maintained controller. PreviewForge is a greenfield project, so the runtime contract will be `Gateway` plus one `HTTPRoute` per preview. The shared `Gateway` is platform-owned; preview namespaces own only their routes and services.

Sources:

- [Ingress NGINX retirement](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/)
- [Gateway API v1.5](https://kubernetes.io/blog/2026/04/21/gateway-api-v1-5/)

### A namespace is lifecycle scope, not a complete sandbox

Namespace-per-preview remains useful because deleting the namespace gives deterministic cleanup. It must be combined with least-privilege RBAC, quotas, default-deny network policy, Pod Security Admission, and disabled service-account token mounting. Containers remain a weaker isolation boundary than virtual machines, so the MVP is explicitly a trusted/single-tenant learning deployment rather than a public hostile multi-tenant service.

Sources:

- [Kubernetes multi-tenancy](https://kubernetes.io/docs/concepts/security/multi-tenancy/)
- [Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/)
- [Kubernetes security checklist](https://kubernetes.io/docs/concepts/security/security-checklist/)

### Build with rootless BuildKit and isolate build credentials

The platform executes repository-controlled Dockerfiles. Mounting the host Docker socket into the worker would give the build an unacceptable privilege path. A separate rootless BuildKit deployment is the baseline. BuildKit's own documentation recommends the rootless Kubernetes variant, while also documenting its process-sandbox limitations. Registry credentials stay on the client side or use narrowly scoped short-lived tokens; GitHub credentials never enter the build context or build arguments.

Sources:

- [BuildKit security boundary](https://github.com/moby/buildkit/blob/master/PROJECT.md#security-boundary)
- [BuildKit Kubernetes examples](https://github.com/moby/buildkit/blob/master/examples/kubernetes/README.md)
- [Docker Buildx Kubernetes driver](https://docs.docker.com/build/builders/drivers/kubernetes/)

### Treat webhooks as at-least-once input

Verify `X-Hub-Signature-256` over raw request bytes with a constant-time comparison. Persist `X-GitHub-Delivery` under a unique constraint before translating the event. GitHub reuses the delivery identifier for redelivery, which makes it the natural idempotency key. Acknowledge quickly and perform deployment work asynchronously.

Sources:

- [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [Webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)
- [Using webhooks with GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps)

### Use Kafka deliberately, behind an outbox

Kafka is retained because asynchronous deployment work and independently scalable workers are central to the portfolio story. PostgreSQL is still the system of record. The API writes domain state and an outbox record in one transaction; a relay publishes versioned events. Consumers use the event ID for durable deduplication and re-check the desired commit SHA before every external side effect.

Kafka is not a workflow database and does not make handlers exactly-once across GitHub, PostgreSQL, registries, and Kubernetes. Application-level idempotency remains mandatory.

The local broker uses the current supported official Apache Kafka 4.3.1 image in KRaft mode.

Source: [Apache Kafka supported releases](https://kafka.apache.org/community/downloads/)

### Defer Redis

The original proposal suggested Redis for distributed locks and status caching. Neither is required in the first slice: desired-SHA guards and leases can live in PostgreSQL, while Kafka partitions preserve event order per environment. Redis should be added only after a concrete latency, rate-limit, or coordination need is measured.

### Stream logs with SSE

Deployment logs are a server-to-browser, one-way stream. Server-Sent Events are simpler than WebSockets for this shape and reconnect naturally. Logs will also be stored in bounded chunks so refreshing the page does not lose history. WebSockets remain an option only if bidirectional live control becomes a real requirement.

### Encrypt secrets before they reach Kubernetes

Environment-variable secrets are write-only in the dashboard and encrypted in PostgreSQL with envelope-ready application encryption. Kubernetes Secret is only the delivery mechanism: Kubernetes documents that Secrets are stored unencrypted in etcd by default unless encryption at rest is configured. Preview workload manifests reference Secrets but the control-plane API never returns plaintext values.

Source: [Kubernetes Secrets](https://kubernetes.io/docs/concepts/configuration/secret/)

## Technology baseline

Versions were checked against official release documentation and the npm registry on the research date.

| Area | Choice | Reason |
| --- | --- | --- |
| Runtime | Node.js 22 | Supported by Next.js, NestJS, and stable Prisma; matches the local environment |
| Workspace | pnpm 10 + Turborepo 2 | Small, explicit monorepo orchestration |
| Web | Next.js 16.3 + React 19 | Active LTS Next.js line with current security patches |
| API | NestJS 12 | Modular control plane without splitting into microservices |
| Contracts | Zod 4 | Runtime validation at external and event boundaries |
| Data | PostgreSQL 18 | Source of truth, outbox, idempotency, and leases |
| Events | Kafka 4.3 | Durable asynchronous transport in KRaft mode |
| Builds | Rootless BuildKit | Separates untrusted Dockerfile execution from worker privileges |
| Runtime | Kubernetes + Gateway API | Namespace lifecycle and current routing API |
| Quality | TypeScript 5.9, Biome 2, Vitest 5 | Strict types, one formatter/linter, fast unit tests |

Prisma 8 was an RC and requires Node.js 24 at the research date. If Prisma is selected in milestone M1, use stable Prisma 7.10 rather than an RC; revisit only when the runtime decision changes.

Next.js 16.3 currently has an open monorepo issue in its new TypeScript CLI path. The web app temporarily sets `experimental.useTypeScriptCli: false` and still runs an explicit `tsc --noEmit` quality gate. Remove the workaround after the upstream issue is fixed; do not replace it by ignoring build type errors.

Sources:

- [Next.js releases](https://nextjs.org/blog)
- [Next.js TypeScript CLI monorepo issue](https://github.com/vercel/next.js/issues/96589)
- [Prisma system requirements](https://docs.prisma.io/docs/orm/reference/system-requirements)
- [Prisma 7 upgrade baseline](https://docs.prisma.io/docs/orm/v6/more/upgrades/to-v7)

## Risks to revisit before public exposure

1. Public hostile multi-tenancy requires a stronger workload boundary such as sandboxed runtimes, dedicated nodes, or dedicated clusters.
2. Arbitrary outbound network access lets builds or previews exfiltrate data they can read. Egress policy needs an explicit product stance.
3. Build cache sharing can cross trust boundaries. Cache scope must follow tenant scope.
4. Wildcard DNS and TLS ownership differ between local clusters and EKS; the Gateway provider must be selected before cloud work.
5. Cleanup must be reconciled from Kubernetes labels as well as database state so leaked namespaces are eventually removed.
