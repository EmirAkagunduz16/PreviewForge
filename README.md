# PreviewForge

PreviewForge is a small developer platform that creates an isolated, temporary preview environment for each GitHub pull request.

The first release supports one GitHub repository, one Dockerfile, one HTTP container, and one preview environment per pull request. The local runtime provisions disposable platform dependencies and a kind/Kubernetes preview cluster; user applications still do not get multiple containers, persistent storage, or an application database.

## Status

M0 through M8 are complete and archived with evidence. The repository is in M9, the local-product-experience milestone: one-command local runtime, browser onboarding/import, clickable local preview routing, and deterministic end-to-end acceptance. The paid AWS cloud demo is re-sequenced as blocked M10 work. The current unfinished slices and their exact verification state are tracked in [the active backlog](docs/backlog/active.md). The [roadmap](docs/delivery/roadmap.md) is the source of truth for milestone status.

## Architecture at a glance

```text
GitHub App webhook
        |
        v
NestJS control plane ---- PostgreSQL
        |                     |
        |                 outbox relay
        v                     v
      Kafka ------------ deployment worker
                              |
                    +---------+---------+
                    |                   |
                 BuildKit          Kubernetes API
                                         |
                                   Gateway API URL
```

The dashboard receives one-way deployment updates and logs over Server-Sent Events. Kafka transports durable workflow events; PostgreSQL remains the source of truth.

## Prerequisites

- Node.js 22
- pnpm 10
- Docker with Compose
- kubectl
- kind (required from the Kubernetes milestone onward)

Run `pnpm run doctor` to inspect the current machine. The explicit `run` is required because pnpm also has a built-in command named `doctor`.

## Getting started

```bash
cp .env.example .env
pnpm install
pnpm local:up
```

`pnpm local:up` is the foreground local runtime supervisor. It preflights the
Docker context, accepted rootless BuildKit socket, kind/Gateway prerequisites,
database migrations, and service health before reporting the dashboard ready.
Use `pnpm local:status` from another terminal and `pnpm local:down` to stop only
the owned runtime. Complete first-time setup, including the rootless BuildKit
boundary and GitHub webhook reachability, is documented in
[local development operations](docs/operations/local-development.md).
For a credential-free local product journey, use the controlled GitHub fixture
described in [local GitHub App operations](docs/operations/local-github-app.md).

Local infrastructure commands use the project-scoped `default` Docker context and do not change your global selection. Override it when needed with `PREVIEWFORGE_DOCKER_CONTEXT=<name> pnpm infra:up`; the standard `DOCKER_CONTEXT` variable is also supported. `pnpm run doctor` checks the same context and verifies both the daemon and Compose plugin.

- Web: <http://localhost:3000>
- API health: <http://localhost:4000/health>
- Kafka: `localhost:59092`
- PostgreSQL: `localhost:55432`
- OCI registry: `localhost:55000`

Set the matching `PREVIEWFORGE_POSTGRES_LOCAL_PORT`,
`PREVIEWFORGE_KAFKA_LOCAL_PORT`, or `PREVIEWFORGE_REGISTRY_LOCAL_PORT` values
when a default port is already occupied; keep `DATABASE_URL`, `KAFKA_BROKERS`,
`REGISTRY_HOST`, and `CONTAINER_REGISTRY` aligned.

When a preview reaches `READY`, the dashboard and GitHub Check expose the same
clickable local URL, for example
`http://preview-<environment-id>.preview.localhost:18080/`. The hostname is the
HTTPRoute identity; `18080` is the loopback Gateway forward.

Run the complete local quality gate with:

```bash
pnpm check
```

## Repository policy

`PreviewForge/` is an independent Git repository whose primary branch is `main`. It intentionally has no remote until the maintainer creates or selects the dedicated PreviewForge repository; do not attach it to the parent Desktop/FlowOps remote. When the destination is known, add it explicitly with `git remote add origin <previewforge-repository-url>`.

## Project map

- `apps/web`: Next.js dashboard
- `apps/api`: NestJS control-plane HTTP API
- `apps/worker`: asynchronous deployment worker shell
- `packages/contracts`: shared domain and event contracts
- `infrastructure/local`: local dependencies
- `docs/plans` and `docs/backlog`: ordered execution plans and resumable unfinished/completed work
- `docs/reports` and `docs/knowledge`: verified project memory, incidents, decisions, research, and session distillations
- `.agents/skills`: project-specific Codex delivery, control-plane, and Kubernetes skills

Begin with [the MVP scope](docs/product/mvp-scope.md), [system design](docs/architecture/system-design.md), [the roadmap](docs/delivery/roadmap.md), and [active backlog](docs/backlog/active.md). Use the backlog for next actions; use reports and [project memory](docs/knowledge/previewforge-memory.md) only when historical or durable context is needed.
