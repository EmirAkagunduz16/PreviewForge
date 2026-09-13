# Active backlog

Only unfinished work belongs here. Update this file before starting work and before handing off.

## M3 — Kafka dispatch and worker claims

```yaml
- id: M3-CONTRACTS
  status: in-progress
  title: Define strict versioned Kafka event and routing boundaries
  owner: contracts
  depends_on: [M2]
  next_action: Implement the allow-listed event union, topic/header/key mapping, and adversarial identity tests.
  acceptance: Malformed, unsupported, secret-bearing, or identity-inconsistent events cannot cross the Kafka boundary.
  evidence: not-run

- id: M3-DATA
  status: in-progress
  title: Add durable relay claims, deployment leases, delivery attempts, and dead-letter visibility
  owner: database
  depends_on: [M2]
  next_action: Apply an additive M3 migration and prove constraints against real PostgreSQL.
  acceptance: Existing data migrates and invalid claim, fencing, retry, receipt, or dead-letter states are rejected durably.
  evidence: not-run

- id: M3-OUTBOX
  status: queued
  title: Claim and settle outbox publication safely under at-least-once delivery
  owner: outbox-relay
  depends_on: [M3-CONTRACTS, M3-DATA]
  next_action: Wait for Wave 1, then implement token-guarded claim, publish settlement, backoff, and dead-letter operations.
  acceptance: Concurrent relays, expired claims, send failure, and ack-before-mark crash preserve every committed intent.
  evidence: not-run

- id: M3-CLAIMS
  status: queued
  title: Atomically receipt, fence, claim, renew, take over, and supersede deployments
  owner: deployment-claims
  depends_on: [M3-CONTRACTS, M3-DATA]
  next_action: Wait for Wave 1, then implement the PostgreSQL command/lease transaction and concurrency tests.
  acceptance: One fenced owner advances desired work; expired leases transfer safely; stale owners and stale SHAs cannot advance state.
  evidence: not-run

- id: M3-WORKER
  status: queued
  title: Run the Kafka relay and deployment consumer with classified bounded retry
  owner: worker
  depends_on: [M3-CONTRACTS, M3-DATA, M3-OUTBOX, M3-CLAIMS]
  next_action: Implement transport adapters in parallel where independent, then wire them after database contracts stabilize.
  acceptance: Offsets follow durable outcomes; duplicates are harmless; poison/exhausted messages become redacted PostgreSQL dead letters.
  evidence: not-run

- id: M3-ACCEPTANCE
  status: queued
  title: Prove restart, duplicate, lease, receipt, retry, and desired-SHA behavior end to end
  owner: root-orchestrator
  depends_on: [M3-OUTBOX, M3-CLAIMS, M3-WORKER]
  next_action: Run real Kafka/PostgreSQL subprocess and container-restart acceptance plus deliberate guard faults after agents quiesce.
  acceptance: Broker or worker restarts lose no intent and create no duplicate transition; all final proof and cleanup checks pass.
  evidence: not-run
```
