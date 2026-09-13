# ADR 0001: Modular control plane and worker

Status: Accepted

## Decision

Use a pnpm/Turborepo monorepo with three applications: Next.js web, one modular NestJS API, and one deployment-worker application. Scale API and worker processes independently; do not split domain modules into network services.

## Rationale

The system needs one asynchronous execution boundary because deployments outlive HTTP requests. More services would add contracts, deployment units, and failure modes without improving the MVP. Shared packages contain contracts and tooling only, not a distributed shared business-logic layer.

## Consequences

Module boundaries must stay explicit inside the API. A future extraction requires an ADR with a measured scaling, isolation, ownership, or release-cadence reason.
