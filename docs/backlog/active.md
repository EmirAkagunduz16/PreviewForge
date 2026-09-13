# Active backlog

Only unfinished work belongs here. Update this file before starting work and before handing off.

## M2 — GitHub App vertical slice

```yaml
- id: M2-CONTRACTS
  status: in-progress
  title: Define strict GitHub, project-import, and deletion-event boundaries
  owner: contracts
  depends_on: [M1]
  next_action: Implement the schemas and adversarial boundary tests in the files reserved by the M2 ownership ledger.
  acceptance: Malformed or secret-bearing inputs are rejected/normalized and only versioned safe events cross package boundaries.
  evidence: not-run

- id: M2-DATA
  status: in-progress
  title: Add durable M2 identity, auth, project, and webhook-ordering state
  owner: database
  depends_on: [M1]
  next_action: Add and apply the M2 Prisma migration with PostgreSQL constraint tests.
  acceptance: Empty and existing database migrations succeed; canonical IDs, sessions/state, ciphertext, project config, and source-order data have safe constraints.
  evidence: not-run

- id: M2-FOUNDATION
  status: in-progress
  title: Add GitHub configuration, crypto, HTTP adapter, raw-body, and DB lifecycle foundations
  owner: api-foundation
  depends_on: [M1]
  next_action: Implement only the Wave 1 foundation files and prove crypto/raw-body/adapter behavior without live secrets.
  acceptance: Startup fails safely on invalid config; credentials are encrypted/redacted; raw bytes and controlled GitHub HTTP calls are available to later slices.
  evidence: not-run

- id: M2-AUTH-INSTALL
  status: in-progress
  title: Implement GitHub App sign-in, local sessions, and verified installation setup
  owner: auth-installation
  depends_on: [M2-CONTRACTS, M2-DATA, M2-FOUNDATION]
  next_action: Wait for Wave 1 integration, then implement the owned auth/installation paths.
  acceptance: State/PKCE/replay/spoofing tests prove one authenticated user/session/credential and stable first-owner installation semantics.
  evidence: not-run

- id: M2-IMPORT
  status: in-progress
  title: List authorized repositories and import one Dockerfile project idempotently
  owner: project-import
  depends_on: [M2-CONTRACTS, M2-DATA, M2-FOUNDATION, M2-AUTH-INSTALL]
  next_action: Wait for auth/session contracts, then implement paginated listing and revalidated import.
  acceptance: Pagination, permission denial, Dockerfile validation, rename identity, and concurrent duplicate import are proven over HTTP and PostgreSQL.
  evidence: not-run

- id: M2-WEBHOOK
  status: in-progress
  title: Verify raw GitHub webhooks and apply durable pull-request intent exactly once
  owner: webhook
  depends_on: [M2-CONTRACTS, M2-DATA, M2-FOUNDATION, M1-OUTBOX]
  next_action: Wait for Wave 1 integration, then implement raw HMAC, strict payloads, transactional delivery handling, and source ordering.
  acceptance: Real HTTP/PostgreSQL tests prove invalid signatures write nothing, duplicates/conflicts are safe, rollback is atomic, stale events do not rewind, and close emits deletion intent.
  evidence: not-run

- id: M2-ACCEPTANCE
  status: in-progress
  title: Integrate and independently prove the complete M2 slice
  owner: root-orchestrator
  depends_on: [M2-AUTH-INSTALL, M2-IMPORT, M2-WEBHOOK]
  next_action: Reserve shared wiring, run the acceptance matrix and deliberate faults after all implementation agents are quiescent.
  acceptance: Final proof packet and full pnpm check pass with expected test discovery on safe local runtimes.
  evidence: not-run
```
