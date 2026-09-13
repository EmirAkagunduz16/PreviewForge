# M1 execution plan — Durable control-plane core

Status: complete
Owner: PreviewForge delivery
Source: [delivery roadmap](../delivery/roadmap.md), [system design](../architecture/system-design.md), [ADR 0002](../architecture/decisions/0002-postgres-outbox-and-kafka.md)

## Outcome

Deliver the first vertical control-plane slice: durable PostgreSQL state, validated API boundaries, idempotent state transitions, and transactional outbox records. Keep the slice runnable with `pnpm check`; do not introduce Kafka consumers, GitHub credentials, Kubernetes resources, or Redis ahead of their milestones.

## Ordered work

| Order | ID | Work | Depends on | Acceptance / evidence |
|---:|---|---|---|---|
| 1 | M1-DB | Add PostgreSQL schema and first migration for the ten M1 entities. | M0 | Empty-database migration applies; stable IDs, timestamps, uniqueness/index constraints; command evidence recorded. |
| 2 | M1-CONFIG | Add startup configuration validation. | M1-DB | Invalid config fails before listen; valid local config boots; secrets never print. |
| 3 | M1-OBS | Add request IDs and structured API logs. | M1-CONFIG | Every request has an ID; logs include method/path/status/duration/ID and omit secrets. |
| 4 | M1-ERROR | Add one API error envelope. | M1-CONFIG | Errors expose stable code, message, requestId, safe optional details; no stack/secret leak. |
| 5 | M1-TRANSITIONS | Implement compare-and-set deployment transitions and durable failure reasons. | M1-DB | Legal transition map enforced; stale and terminal rewinds rejected/no-op; failures retain stage/code/redacted message/retryability. |
| 6 | M1-OUTBOX | Persist deployment intent and its outbox event atomically. | M1-DB, M1-TRANSITIONS | Rollback leaves neither; committed intent has deterministic event identity; duplicate command harmless. |
| 7 | M1-TESTS | Add integration and boundary tests. | M1-TRANSITIONS, M1-OUTBOX | PostgreSQL-backed (or documented substitute) tests and `pnpm check` pass with named evidence. |

## Handoff contract

Before every session, token, or time handoff, update `docs/backlog/active.md`. Each unfinished item must include status, dependency/blocker, exact next action and owning file/module, outstanding acceptance, and evidence (command, test, link, or `not-run` reason). When acceptance is proven, remove the item from `active.md` and append its completion record to `archive.md`; do not keep completed work in the active file.

## Definition of done for M1

- All seven M1 items are archived with evidence.
- `pnpm check` passes, including database integration tests.
- Duplicate intent is harmless and terminal deployment states cannot be rewound.
- No secret appears in logs, API envelopes, migrations, or test output.
- The next milestone can consume the persisted outbox contract without changing the M1 domain model.
