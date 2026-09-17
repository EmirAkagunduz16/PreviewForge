# M8 local backup and restore drill

This runbook is for the disposable local M8 acceptance environment. It is a
resilience demo, not a production disaster-recovery commitment and not an AWS
procedure. Never point it at a shared, staging, or production database,
Kafka cluster, registry, or Kubernetes context.

The fixture contract is [fixtures/m8/manifest.json](../../fixtures/m8/manifest.json).
Validate the repository inputs before starting:

```bash
node scripts/m8/fixtures/manifest.mjs --check
```

For the normal local acceptance path, run the automated drill from the
repository root:

```bash
pnpm infra:up
node scripts/m8/fixtures/drill.mjs
```

The runner accepts only the local Compose PostgreSQL/Kafka ports, creates fresh
`previewforge_m8_source_*` and `previewforge_m8_restore_*` databases, applies
current migrations, seeds and repeats the webhook fixture, creates a data-only
checkpoint, restores it into the isolated target, replays durable outbox rows
through the normal Kafka relay, observes the event identities, deletes its
temporary consumer group, and proves database/dump cleanup. It does not create
registry or Kubernetes resources. The JSON output is safe to retain as local
acceptance evidence; it contains no credentials or payload secrets.
The bundled local PostgreSQL service is version 18; the runner invokes the
matching `pg_dump` and `pg_restore` binaries inside that container. Manual host
backup tools must use a compatible major version.

## Invariants

- PostgreSQL is the authoritative workflow and backup source.
- Kafka offsets and topic data are transport state, not the source of truth.
- The restore target is an isolated disposable database with a fresh name.
- Current migrations are applied before restoring the data-only checkpoint.
- Kafka topics are recreated from the contract, then durable outbox rows are
  replayed through the normal relay.
- Registry artifacts are retained by immutable digest for the duration of the
  drill and deleted by ownership after the drill.
- Kubernetes objects are reproducible derived state. The drill records the
  rendered resource identity rather than treating the cluster as a backup.
- Credentials are supplied through the local process environment or a protected
  password file; they are never copied into the dump directory or repository.

## 1. Establish a disposable local identity

Use a fresh, local-only database name and temporary directory. Do not paste a
credential-bearing connection string into shell history. Prefer `.pgpass` or a
protected service definition for PostgreSQL authentication.

```bash
export M8_FIXTURE_ID=m8-local-hardening
export M8_RESTORE_DATABASE=previewforge_m8_restore_$(date +%Y%m%d%H%M%S)
export M8_DUMP_DIR="$(mktemp -d -t previewforge-m8-restore.XXXXXX)"
export M8_DUMP_PATH="$M8_DUMP_DIR/${M8_FIXTURE_ID}.dump"
export M8_DOCKER_CONTEXT="${PREVIEWFORGE_DOCKER_CONTEXT:-default}"
```

Before mutating anything, record redacted local identities:

```bash
docker --context "$M8_DOCKER_CONTEXT" context show
docker --context "$M8_DOCKER_CONTEXT" info --format '{{.Name}}'
kubectl config current-context
kubectl get namespace
```

The expected target is the local Compose PostgreSQL/Kafka/registry and the
disposable kind cluster namespace set aside for M8. If any command identifies a
shared target, stop and do not continue.

## 2. Create a PostgreSQL checkpoint

The checkpoint is data-only because the restore database must receive the
current schema from migrations. Set `M8_SOURCE_DATABASE_URL` through a protected
environment mechanism; do not commit or echo its value.

```bash
pg_dump \
  --dbname="$M8_SOURCE_DATABASE_URL" \
  --format=custom \
  --data-only \
  --no-owner \
  --no-acl \
  --exclude-table-data=_prisma_migrations \
  --file="$M8_DUMP_PATH"

test -s "$M8_DUMP_PATH"
pg_restore --list "$M8_DUMP_PATH" | sed -n '1,40p'
```

The dump must contain the authoritative deployment/environment/outbox facts
needed by the selected fixture. It must not contain `.env` files, Kubernetes
Secret values, access tokens, private keys, or copied Kafka credentials.

## 3. Create and migrate the isolated restore database

Create the database only on the disposable local PostgreSQL instance. The
database name is generated for this drill and must not replace the source.

```bash
createdb --maintenance-db=postgres --dbname="$M8_ADMIN_DATABASE_URL" "$M8_RESTORE_DATABASE"

# Configure this protected value for the database created above. Do not commit
# or echo the resulting connection string.
export M8_RESTORE_DATABASE_URL='postgresql://<local-user>:<local-password>@<local-host>:<local-port>'
DATABASE_URL="$M8_RESTORE_DATABASE_URL" \
  pnpm --filter @previewforge/database exec prisma migrate deploy
```

Confirm the migration table and schema before loading data:

```bash
psql "$M8_RESTORE_DATABASE_URL" \
  -c 'SELECT current_database(), current_schema();' \
  -c 'SELECT migration_name FROM "_prisma_migrations" ORDER BY finished_at;'
```

## 4. Restore authoritative rows and verify the checkpoint

Restore into the migrated, empty database. Do not use a `--clean` restore
against a database that was not created specifically for this drill.

```bash
pg_restore \
  --dbname="$M8_RESTORE_DATABASE_URL" \
  --data-only \
  --no-owner \
  --no-acl \
  --exit-on-error \
  "$M8_DUMP_PATH"
```

Verify the durable state before Kafka is started. The exact counts depend on
which fixture scenario was selected, but every restored deployment must point
to an existing owned environment and every pending transport intent must have
an outbox row:

```bash
psql "$M8_RESTORE_DATABASE_URL" <<'SQL'
SELECT current_database(), current_schema();
SELECT status, count(*) FROM deployments GROUP BY status ORDER BY status;
SELECT status, count(*) FROM preview_environments GROUP BY status ORDER BY status;
SELECT count(*) AS pending_outbox
  FROM outbox_events
 WHERE published_at IS NULL AND dead_lettered_at IS NULL;
SELECT count(*) AS orphan_deployments
  FROM deployments d
  LEFT JOIN preview_environments e ON e.id = d.environment_id
 WHERE e.id IS NULL;
SQL
```

The expected orphan count is zero. Redact IDs and messages in copied evidence;
deployment IDs and commit SHAs are internal correlation data, not public
fixture labels.

## 5. Recreate Kafka topics and replay outbox intent

Create the three topics from the fixture manifest with one partition in the
single-node local broker. Use the broker address reachable from the process that
will run the relay; the Compose container address and host address are not
interchangeable.

```bash
for topic in \
  previewforge.deployment-requests.v1 \
  previewforge.deployment-events.v1 \
  previewforge.environment-commands.v1
do
  docker --context "$M8_DOCKER_CONTEXT" exec previewforge-kafka-1 \
    /opt/kafka/bin/kafka-topics.sh \
    --bootstrap-server kafka:19092 \
    --create --if-not-exists --topic "$topic" \
    --partitions 3 --replication-factor 1
done
```

Start the worker with `DATABASE_URL` pointed at the isolated restore database
and `KAFKA_BROKERS` pointed at the recreated local broker. Keep Kubernetes
reconciliation disabled for the restore-only phase unless the acceptance run
has already established an owned disposable kind context. The normal outbox
relay must publish pending rows and then mark them published after broker
acknowledgement; do not copy old Kafka offsets or inject events directly into a
topic.

Observe both sides of the replay:

```bash
psql "$M8_RESTORE_DATABASE_URL" \
  -c 'SELECT count(*) FROM outbox_events WHERE published_at IS NULL AND dead_lettered_at IS NULL;'

docker --context "$M8_DOCKER_CONTEXT" exec previewforge-kafka-1 \
  /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server kafka:19092 --list
```

The replay oracle is durable: pending outbox rows become published, the Kafka
consumer receives the same event identity, and a repeated replay does not
create a second deployment or a second domain state transition. Kafka alone is
not sufficient evidence of restore success.

## 6. Re-render derived Kubernetes and registry state

Render the preview resources from the restored authoritative rows and record
the redacted resource identity. Every object must retain the platform,
project, environment, deployment, and expiry ownership metadata; workload
service accounts must not auto-mount tokens; and deployment image identity
must be an immutable digest.

For the local registry, record the digest reference used by the restored
deployment and retain only the repository prefix declared in the manifest:

```text
previewforge.dev/m8-fixture=m8-local-hardening
previewforge-m8-<environment-id>
m8-fixtures-<fixture-id>@sha256:<64-hex-digits>
```

Do not restore Kubernetes Secret values from the database dump into logs or
shell output. Environment variables remain encrypted at rest and write-only at
the API boundary.

## 7. Teardown and residue proof

Stop the local worker/API processes, delete only resources carrying the M8
ownership identity, remove the isolated restore database, and delete the
temporary dump directory. Ownership must be checked before every deletion.

```bash
dropdb --if-exists --maintenance-db=postgres --dbname="$M8_ADMIN_DATABASE_URL" "$M8_RESTORE_DATABASE"
rm -f -- "$M8_DUMP_PATH"
rmdir -- "$M8_DUMP_DIR"
```

Final evidence must show zero M8 fixture rows, zero owned preview namespaces,
zero M8 registry repositories or tags, no fixture HTTP processes, no temporary
credential files, and no pending M8 Kafka consumer groups. Pre-existing local
infrastructure may remain only when it is identified as outside the fixture
ownership boundary.

If teardown fails, keep `M8-FIXTURES` active with the exact resource identity
and failed command. Never broaden deletion to a namespace, registry, database,
or Docker volume that was not resolved from the M8 ownership labels.
