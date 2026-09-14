# PreviewForge

PreviewForge is a small developer platform that creates an isolated, temporary preview environment for each GitHub pull request.

The first release supports one GitHub repository, one Dockerfile, one HTTP container, and one preview environment per pull request. It deliberately does not provision Kubernetes clusters or application databases.

## Status

The repository is in M5, the Kubernetes preview-reconciliation phase. M0 through M4 are complete and archived with evidence. The current unfinished slices and their exact verification state are tracked in [the active backlog](docs/backlog/active.md). The [roadmap](docs/delivery/roadmap.md) is the source of truth for milestone status.

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
pnpm infra:up
pnpm dev
```

Local infrastructure commands use the project-scoped `default` Docker context and do not change your global selection. Override it when needed with `PREVIEWFORGE_DOCKER_CONTEXT=<name> pnpm infra:up`; the standard `DOCKER_CONTEXT` variable is also supported. `pnpm doctor` checks the same context and verifies both the daemon and Compose plugin.

- Web: <http://localhost:3000>
- API health: <http://localhost:4000/health>
- Kafka: `localhost:59092`
- PostgreSQL: `localhost:55432`
- OCI registry: `localhost:55000`

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
