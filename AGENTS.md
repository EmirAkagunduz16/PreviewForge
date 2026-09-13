# PreviewForge agent guide

User instructions take precedence over this file. Keep changes scoped to the requested milestone and preserve the MVP boundaries in `docs/product/mvp-scope.md`.

## Start here

- Read `docs/architecture/system-design.md` before changing component boundaries.
- Read the relevant ADR before replacing an accepted decision.
- For planning, backlog, handoff, or durable reporting work, also read `.agents/skills/previewforge-delivery/SKILL.md`.
- For milestone planning or implementation with subagents, also read `.agents/skills/previewforge-milestone-orchestrator/SKILL.md`.
- For control-plane, webhook, event, or deployment-state work, also read `.agents/skills/previewforge-control-plane/SKILL.md`.
- For Kubernetes, BuildKit, routing, or workload security work, also read `.agents/skills/previewforge-kubernetes/SKILL.md`.

## Working agreements

- Follow `.agents/skills/previewforge-delivery/SKILL.md`: add unfinished work to `docs/backlog/active.md` before handoff and archive only with evidence.
- Record durable incidents, decisions, research, and architecture lessons under `docs/reports/`; sync verified distillations to VictusOS only after the project-canonical report exists.
- Use pnpm and Turborepo. Do not introduce another package manager.
- Prefer vertical slices that leave the repository runnable.
- Keep the control plane as one NestJS application plus independently scalable worker processes. Add a new service only through an ADR.
- Keep external payloads and event messages at the boundary; validate them before converting them to domain types.
- Treat every GitHub webhook and Kafka message as at-least-once delivery. Handlers must be idempotent.
- A deployment may publish or deploy artifacts only while its commit SHA is still the environment's desired SHA.
- Never pass GitHub, registry, database, or platform credentials into a user Docker build.
- Never log secret values. Kubernetes Secret values and encrypted database fields must stay redacted in API responses.
- User workloads must not receive a Kubernetes API token and must define resource requests/limits and restricted security contexts.
- Do not add Redis until a measured use case cannot be handled safely by PostgreSQL or Kafka.

## Commands

- Install: `pnpm install`
- Develop all apps: `pnpm dev`
- Full local verification: `pnpm check`
- Format: `pnpm format`
- Start dependencies: `pnpm infra:up`
- Stop dependencies: `pnpm infra:down`
- Check host prerequisites: `pnpm run doctor`

Run the narrowest relevant checks while iterating, then run `pnpm check` before handing off a completed change. Do not claim Kubernetes behavior was verified unless it was exercised against a real test cluster.

## Code review rules

- Flag state transitions that bypass the transition map or do not record a durable failure reason.
- Flag webhook processing that verifies a parsed/re-serialized body instead of the raw request bytes.
- Flag event consumers without a durable idempotency key or atomic state guard.
- Flag preview resources without ownership labels, TTL metadata, resource limits, default-deny network policy, or `automountServiceAccountToken: false`.
- Flag mutable image tags used as deployment identity; deploy immutable digests.
