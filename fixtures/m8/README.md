# M8 local fixtures

This directory contains deterministic, synthetic inputs for the local M8
hardening run. It is not a GitHub credential store, a production image source,
or an AWS deployment bundle.

The canonical entry point is [`manifest.json`](manifest.json). Validate it with:

```bash
node scripts/m8/fixtures/manifest.mjs --check
```

The manifest references three pull-request webhook payloads, duplicate/delayed/
lost-response delivery cases, Check Run responses, source contexts for healthy,
build-failure, and health-failure paths, and a retryable source-upstream case.
All identities, timestamps, and commit SHAs are fixed so a seed can be repeated
without depending on wall-clock values or random IDs.

Credentials remain runtime-only. A future controlled GitHub HTTP fixture may
receive a test secret from the process environment, but no token, private key,
password, or authorization header belongs in this directory.

The fixture ownership contract is deliberately explicit:

- Kubernetes resources use `previewforge.dev/m8-fixture=m8-local-hardening`.
- Preview namespaces use the `previewforge-m8-` prefix.
- Disposable registry repositories use the `m8-fixtures-` prefix.
- PostgreSQL remains authoritative; Kafka is recreated and repopulated by
  replaying durable outbox rows.

The restore and teardown procedure is documented in
[`docs/operations/m8-backup-restore.md`](../../docs/operations/m8-backup-restore.md).

The repeatable local PostgreSQL/Kafka drill is run from the repository root:

```bash
node scripts/m8/fixtures/drill.mjs
```

It refuses non-loopback targets, creates uniquely named disposable databases,
and reports the seed, restore, outbox replay, and teardown evidence as JSON.
