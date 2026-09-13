# M3 Kafka dispatch and worker claims plan

Status: active

Baseline commit: `f79286495c6ed892f8960824b438b5259e3ac746`

Baseline tree: `ccbce2c4307e55559efc7f11a9d590570869b6b9`

## Milestone contract

M3 relays committed PostgreSQL outbox events to Kafka and lets a worker consume `deployment.requested.v1` at least once. PostgreSQL remains authoritative. Kafka offsets, producer idempotence, and process lifetime are never the only proof that work exists or was processed.

The worker may atomically claim a desired queued deployment and move it to `CLONING`, but M3 performs no repository acquisition, image build/push, Kubernetes mutation, health check, or GitHub check update. Those remain M4-M7 work. Redis and a separate network service remain excluded.

## Resolved decisions

- Use one worker deployment unit with independently runnable relay and consumer roles; do not add a service boundary.
- Use Kafka topics `previewforge.deployment-requests.v1`, `previewforge.deployment-events.v1`, and `previewforge.environment-commands.v1`. Partition keys are the event's `environmentId`.
- Validate an allow-listed versioned event union before publication and again at consumption. The outbox row ID, payload `eventId`, event type, topic mapping, header identity, key, and payload environment identity must agree.
- Use Kafka acknowledgement-all, one in-flight request, an explicit stable partitioner, and bounded transport retry. KafkaJS warns that bounding its retries invalidates its producer-idempotence guarantee, so M3 does not enable or claim Kafka producer exactly-once behavior; PostgreSQL event receipts remain the idempotency authority.
- Persist outbox claim ownership, lease expiry, attempts, retry schedule, redacted failure, and dead-letter status in PostgreSQL. `publishedAt` is written only after broker acknowledgement and only by the current claim token.
- Persist message-delivery attempts/dead letters without raw payloads. Store topic/partition/offset, safe identity when parseable, payload digest, stable error code, redacted message, attempts, retry time, and terminal status.
- Keep semantic deduplication in `ConsumerReceipt(consumerName,eventId)`. Receipt, lease/state mutation, and transition outbox event commit atomically.
- Store a fencing token and generation on the deployment lease. An expired lease may be taken over; the prior token cannot renew, release, or advance state.
- A duplicate receipt does not permanently strand work: an expired `CLONING` lease can be reclaimed without replaying the `QUEUED→CLONING` transition.
- A stale requested deployment is atomically moved to `SUPERSEDED`, receipted, and acknowledged. It is not retried.
- Retry only classified transient broker, network, PostgreSQL `40001`/`40P01`, and equivalent typed transport failures with capped exponential backoff and jitter. Malformed, unsupported, identity-mismatched, and exhausted messages become PostgreSQL-visible dead letters. No raw message or secret is persisted.
- M3 dead-letter authority is PostgreSQL. A Kafka DLQ topic is deferred until an operational consumer requires it.

## Dependency waves and ownership ledger

The baseline has one protected dirty path: `apps/web/next-env.d.ts` with SHA-256 `0f70629890b72a0a82e91972cc032c04b658b26c265373cb711cf576bfbf8fcc`. Every M3 agent must leave it untouched.

| Wave | Slice | Exclusive writable ownership | Forbidden/shared paths |
|---|---|---|---|
| 1 | M3-CONTRACTS | `packages/contracts/src/kafka.ts`, `packages/contracts/test/kafka.test.ts` | Existing contract files and all indexes/manifests are root-owned. |
| 1 | M3-DATA | `packages/database/prisma/schema.prisma`, `packages/database/prisma/migrations/20260913160000_m3_kafka_dispatch/`, `packages/database/test/m3-migration.integration.test.ts` | Existing migrations/repositories/tests and indexes are forbidden. |
| 2 | M3-OUTBOX | `packages/database/src/outbox-relay-repository.ts`, `packages/database/test/outbox-relay-repository.integration.test.ts` | Schema, migration, shared index, worker files, and existing repositories are forbidden. |
| 2 | M3-CLAIMS | `packages/database/src/deployment-claim-repository.ts`, `packages/database/test/deployment-claim-repository.integration.test.ts` | Existing deployment repository/tests, schema, migration, and shared index are forbidden. |
| 2 | M3-WORKER | `apps/worker/src/config.ts`, `apps/worker/src/kafka/`, `apps/worker/src/outbox-relay.ts`, `apps/worker/src/deployment-consumer.ts`, matching unit tests | Worker entrypoint/manifests, lockfile, database code, and contract indexes are root-owned. |
| 3 | M3-ACCEPTANCE | Root only: worker entrypoint, shared exports, manifests/lockfile, scripts, acceptance tests, plan/backlog/reports | Root integrates only after all agents are quiescent. |

Root reserves `packages/contracts/src/index.ts`, `packages/database/src/index.ts`, `apps/worker/src/main.ts`, `apps/worker/package.json`, root `package.json`, `pnpm-lock.yaml`, environment examples, all documentation, and runtime orchestration. No two active agents receive the same writable path.

## Acceptance matrix

| Slice | Risk | Stimulus | Observable oracle | Fault sensitivity | Runtime |
|---|---|---|---|---|---|
| M3-CONTRACTS | Malformed, unsupported, secret-bearing, or identity-inconsistent events cross the boundary. | Invalid JSON/UUID/version, unknown fields, row/payload/header/key mismatch. | Parse fails with stable safe code; no unknown field survives normalization. | Removing strict validation or an identity comparison makes a targeted test fail. | Unit contract fixtures. |
| M3-DATA | Leases, retries, or dead letters admit invalid combinations or lose existing rows. | Apply migration to existing M2 data; write expired/current claims, negative attempts, published-and-dead-letter states, unsafe error text. | Three prior migrations plus M3 apply; constraints reject invalid state; existing rows remain readable. | Dropping a claim/dead-letter/check constraint makes a PostgreSQL test fail. | Disposable and primary local PostgreSQL 18.1. |
| M3-OUTBOX | A committed intent is lost, concurrently over-published, or marked by a stale relay. | Two relay owners race; claim expires; Kafka send fails; ack succeeds then mark is skipped; old token marks late. | One active claim; attempts/backoff/error are durable; only current token marks; restart republishes unmarked event; row is never deleted. | Mark-before-send or token-guard removal fails row/Kafka count assertions. | Real PostgreSQL and Kafka 4.3.1. |
| M3-CLAIMS | Two workers execute one deployment or an expired owner mutates state. | Concurrent claim, renew, expiry takeover, stale-token transition, receipt replay, desired SHA change. | One fenced owner; generation increases on takeover; receipt/state/transition event are atomic; stale token fails; stale deployment becomes `SUPERSEDED`. | Removing lease token, receipt unique guard, transaction boundary, or desired-SHA predicate fails durable counts/state. | Real PostgreSQL with concurrent clients. |
| M3-WORKER | Offset acknowledgement loses work, poison messages loop, or duplicates repeat state. | Duplicate publish, invalid/key-mismatched message, retryable failure, DB commit then no offset commit, consumer restart. | Valid event yields one receipt/transition; retry remains bounded; invalid event yields one redacted DB dead letter; offset commits only after durable outcome. | Auto-commit, early receipt, raw payload persistence, or retry-all mutation fails Kafka/DB assertions. | Real Kafka and PostgreSQL; controlled failure hooks. |
| M3-ACCEPTANCE | Broker/worker restart or reordered/stale delivery violates eventual processing and desired state. | Restart relay/consumer subprocesses; restart local Kafka container; publish duplicates and stale event after new desired SHA. | Unpublished outbox survives; eventual broker delivery occurs; one semantic receipt and transition remain; expired lease is reclaimable; stale work is `SUPERSEDED`; no fixture residue remains. | Disable receipt, outbox claim guard, lease fencing, or desired-SHA guard and require the corresponding test to fail before restoration. | Verified local Docker context `default`, Kafka 4.3.1 at `localhost:59092`, PostgreSQL 18.1 at `localhost:55432`. |

## Exit checklist

- Every active M3 slice has root-run direct test discovery and expected/observed case counts.
- A real relay subprocess survives broker unavailability/restart without losing committed intent.
- A real consumer subprocess survives a commit-before-offset crash without duplicating durable state.
- Lease expiry/takeover and stale-owner fencing are proven against PostgreSQL server time.
- Duplicate, malformed, reordered, stale-SHA, retryable, non-retryable, and exhausted inputs have durable safe outcomes.
- PostgreSQL remains the source of truth; Redis, BuildKit, registry publication, Kubernetes behavior, and GitHub checks are absent from M3 claims.
- Critical guards have executed fault-sensitivity evidence and the correct tree is restored.
- `pnpm check` passes with real PostgreSQL/Kafka integration tests included explicitly; zero-test success is rejected.
- Final runtime identity, commands, counts, commit/tree, changed files, cleanup, and limitations are recorded before archival.

## Known local limitation

The local Kafka topology is one broker without a persisted Kafka volume. Container restart/reconnect and at-least-once application behavior can be proven; multi-broker replication, disk-loss durability, partitions, and production high availability cannot be claimed.
