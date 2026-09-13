# ADR 0002: PostgreSQL source of truth with Kafka and an outbox

Status: Accepted

## Decision

Persist deployment intent and an outbox record in one PostgreSQL transaction. Publish versioned events to Kafka asynchronously. Consume at least once using event IDs and atomic desired-state guards.

## Rationale

Kafka is justified by long-running work, event history, independent workers, and the project's learning goals. The transactional outbox closes the database-to-broker dual-write gap. Kafka is not used as the authoritative workflow store.

## Consequences

An outbox relay, consumer receipt strategy, event schema compatibility, dead-letter handling, and lag observability are required. Redis is not part of the initial coordination path.
