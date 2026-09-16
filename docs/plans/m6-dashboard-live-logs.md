# M6 execution plan — dashboard and live logs

Status: active
Owner: PreviewForge delivery
Roadmap: [M6 — Dashboard and live logs](../delivery/roadmap.md#M6--dashboard-and-live-logs-active--week-6)
Sources: [MVP scope](../product/mvp-scope.md), [system design](../architecture/system-design.md), [deployment state machine](../architecture/deployment-state-machine.md), [ADR 0005 — SSE](../architecture/decisions/0005-sse-for-live-output.md), [control-plane skill](../../.agents/skills/previewforge-control-plane/SKILL.md)

## Outcome

Give an authenticated GitHub user a durable, owner-scoped view of their projects,
active previews, deployment attempts, current stages/failures, and bounded build logs.
The browser can resume live log delivery after refresh or disconnect. Users can add,
replace, and remove encrypted environment-variable values without any read API ever
returning a value; the worker supplies those values only to the preview runtime, never
to BuildKit, Kafka, or logs.

The outcome is M6 only: no PR-close/TTL/orphan cleanup (M7), GitHub check runs (M7),
cluster provisioning, production RBAC/CNI claims, metrics/traces, or cloud deployment
(M8). No terminal, WebSocket, Redis, arbitrary manifests, multiple containers, or
cross-provider integrations are introduced.

## Existing contracts and boundaries

- `Project`, `PullRequest`, `PreviewEnvironment`, `Deployment`, and `LogChunk` already
  exist in PostgreSQL. `LogChunk` already has `(deploymentId, sequence)` uniqueness,
  `stage`, `stream`, `text`, and `emittedAt`; no M6 migration is needed unless an
  approved bounded-retention implementation requires an additional index/field. The
  approved age cutoff is based on `createdAt`, which `LogChunk` does not currently
  have; M6-LOG-DURABILITY must add a persisted `createdAt` timestamp and migration
  (backfill existing rows from `emittedAt` if any exist) rather than treating `emittedAt`
  as equivalent.
- Project ownership comes from `Project.ownerId`; authorization must be enforced in
  every read/write query through the authenticated session, not only in the browser.
  Return the same not-found result for absent and non-owned resources. Use the existing
  `AuthService`, HttpOnly session cookie, API exception envelope, and request ID.
- PostgreSQL remains authoritative. Read APIs query the database. The worker writes
  log chunks to PostgreSQL; the API replays/polls those rows for SSE. Do not put log
  bodies or environment-variable values in Kafka/outbox events, request logs, or
  BuildKit args/environment.
- Keep the one Nest API plus independently scalable worker topology. Reuse SSE from
  ADR 0005; do not add Redis/WebSockets or a new service. Each SSE connection reads
  durable state from PostgreSQL and releases timers/listeners on disconnect.
- Use the existing deployment status enum and transition contract. The stage display
  is derived from the ordered statuses in `packages/contracts/src/deployment.ts`;
  deployment history is ordered by attempt/creation time. Do not create UI-only
  states or mutate status from dashboard requests.
- Establish a same-origin browser `/api` path through a configured Next.js rewrite to
  the API. Set the OAuth public callback base to the browser origin so the existing
  HttpOnly `SameSite=Lax` cookie survives the callback and is sent through the proxy.
  Do not enable wildcard credentialed CORS. Production edge routing remains an M8
  deployment concern.
- Keep environment-variable encryption authenticated and versioned. The existing
  AES-256-GCM `CredentialCipher` is API-private today, while both API and worker need
  compatible encrypt/decrypt behavior. Extract only that primitive to a small shared
  security package rather than importing API implementation into the worker. Bind
  ciphertext to its owner/project/key with associated data. API key-list responses
  expose names and update metadata only. Worker decrypts from PostgreSQL after build
  and passes plaintext only to M5's Kubernetes environment input.
- Logs are untrusted user-build output. Persist bounded UTF-8 chunks, validate stream
  and stage identifiers, strip terminal control sequences, render as text (never
  HTML), and never include runtime environment-variable values. Cursor IDs are
  deployment-local monotonically increasing log sequence numbers. On reconnect, the
  server re-reads current deployment state and replays retained logs after the cursor.
  If retention has removed the cursor range, send an explicit gap/reset indication;
  never silently claim that omitted historical output was replayed.

## Locked product decisions — approved 2026-09-16

The user explicitly approved these M6 product contracts on 2026-09-16. They are locked
for implementation; do not substitute the earlier recommendations or silently alter
the limits. Canonical evidence: [M6 product-contract decision](../reports/decision-2026-09-16-m6-product-contract.md).

1. **Environment variables are project-scoped and shared by every PR preview belonging
   to that project.** Storage keys, owner-scoped API routes, dashboard controls, and
   worker lookup must all follow this scope. Values remain encrypted and write-only.
2. **Log bounds are measured on UTF-8 encoded `text` bytes:** at most 16 KiB (`16 *
   1024 = 16,384` bytes) per persisted chunk, at most 2 MiB (`2 * 1024 * 1024 =
   2,097,152` bytes) of retained log text per deployment, and a 30-day age retention
   window. Age expiry is determined from persisted `createdAt` (not `emittedAt`).
   Split oversized input at UTF-8 boundaries into chunks that satisfy the per-chunk
   limit. When either total-cap or age retention evicts older chunks, an SSE request
   whose `Last-Event-ID` points into removed history must emit an explicit `event: gap`
   with the oldest retained sequence (or next sequence when no chunks remain); clients
   must visibly reset/resume from that boundary and must not treat omitted output as
   replayed.

Secret values remain excluded from build context, image layers, event payloads, API
responses, and logs. `M6-PRODUCT-CONTRACT`, `M6-ENV-VARS`, and `M6-LOG-DURABILITY` are
closed. Execute remaining slices sequentially under the ownership ledger. Full M5
acceptance has a repeatable health classification drift that must be resolved before
integrated M6 acceptance (see the [incident report](../reports/incident-2026-09-16-m5-health-acceptance-drift.md)).

## Baseline and sequential ownership ledger

Planning baseline: HEAD `165d06c4fdc797de89c765e483d776742a95446a`, tree
`5941e7db6c2e473c06321a0db68ccc5c1a49691c`. At plan start, staged paths were empty,
untracked paths were empty, and these two pre-existing root-owned unstaged files were
protected (SHA-256 shown for the current contents):

```yaml
baseline_commit: 165d06c4fdc797de89c765e483d776742a95446a
baseline_tree: 5941e7db6c2e473c06321a0db68ccc5c1a49691c
staged_paths: []
protected_unstaged:
  docs/reports/index.md: 40be1d3a1fe60b99083037d7e965a95287856ec8c0849e2599f567992799e38a
  docs/reports/incident-2026-09-14-m4-rootless-host-prerequisite.md: 2105e8048755a7b4d1b0d19b38cb0bb0c9d4ad05c2e4d2db9224a7a2bef929ed
untracked_paths: []
agent_policy: one Luna medium agent, sequential slices only; no parallel lanes
protected_paths: [docs/reports/index.md, docs/reports/incident-2026-09-14-m4-rootless-host-prerequisite.md, .git/, .agents/, .env, .env.local]
root_owned_shared_paths: [pnpm-lock.yaml, package.json, pnpm-workspace.yaml]
```

The same Luna medium agent owns one slice at a time in this order; the root owns
integration, runtime identity, final acceptance, shared package wiring/lockfiles, and
completion evidence. Before each handoff, refresh the commit/tree/status ledger and
preserve any newly dirty paths. Never overlap edits to Prisma schema/migrations,
database exports, API module wiring, or the web proxy configuration.

| Order | Slice | Owned paths | Depends on |
|---:|---|---|---|
| 1 | M6-QUERY-API | `packages/database/src/dashboard-repository.ts`, its database tests, `packages/database/src/index.ts`, `apps/api/src/dashboard/`, `apps/api/src/app.module.ts`, API tests | M5 complete |
| Gate | M6-PRODUCT-CONTRACT | `docs/plans/m6-dashboard-live-logs.md`, `docs/backlog/active.md`, decision report | Query API design review and explicit user approval; closed 2026-09-16 |
| 2 | M6-ENV-VARS | Prisma schema + one migration, `packages/database/src/project-environment-repository.ts`, `packages/security/`, API environment-variable module/config/tests, worker config/runtime integration/tests, M5 Kubernetes environment seam | M6-PRODUCT-CONTRACT (closed; project scope locked) |
| 3 | M6-LOG-DURABILITY | Prisma schema + one additive migration for `LogChunk.createdAt`, `packages/database/src/log-chunk-repository.ts`, database tests/exports, worker BuildKit log streaming/pipeline/config/tests | M6-PRODUCT-CONTRACT (closed; byte/age/gap policy locked) |
| 4 | M6-SSE-API | `apps/api/src/live-output/`, `apps/api/src/app.module.ts`, API tests; log read methods in the owned database repository | M6-QUERY-API, M6-LOG-DURABILITY |
| 5 | M6-DASHBOARD | `apps/web/app/`, `apps/web/next.config.ts`; web tests; `.env.example` only after root reserves it | M6-QUERY-API, M6-ENV-VARS, M6-SSE-API |
| 6 | M6-ACCEPTANCE | `apps/api/src/m6.integration.test.ts`, `apps/web` acceptance harness only if an existing supported browser harness is available | all prior slices |

If a feature needs an unowned path, the agent stops and returns the exact needed path
to root. Do not create a new service or modify protected root-owned report files.

## Slice contracts

### M6-QUERY-API

- Dependency: M5 complete; this is the first implementation slice.
- Objective and owned paths: deliver owner-scoped, paginated project, active-preview,
  deployment-history, and detail projections in `packages/database/src/dashboard-repository.ts`,
  database exports/tests, `apps/api/src/dashboard/`, module wiring, and API tests.
- Acceptance and verification: disposable PostgreSQL tests prove isolation, stable
  pagination, correct preview joins, and status/attempt projections; run
  `pnpm --filter @previewforge/database test:integration` and
  `pnpm --filter @previewforge/api test`.
- Status: complete on 2026-09-16; does not mark M6 complete.
- Evidence: focused PostgreSQL repository test 1/1; real HTTP/PostgreSQL API test 1/1;
  API unit tests 53/53; full `pnpm check` passed. Canonical evidence:
  [M6 Query API session report](../reports/session-2026-09-16-m6-query-api.md).
- Implementation commit: `12a89d73a0a7dca554316245f2e17429517c6163`.
- Next action: the approved gate and dependent M6-ENV-VARS slice are closed; continue
  sequentially with M6-LOG-DURABILITY.

### M6-PRODUCT-CONTRACT

- Dependency: query API design review and explicit user approval, satisfied 2026-09-16.
- Status/evidence: complete and archived as `M6-PRODUCT-CONTRACT`; the exact locked
  scope and byte/age/gap contract is recorded above and in the
  [canonical decision report](../reports/decision-2026-09-16-m6-product-contract.md).
- Objective and owned paths: record approved choices in this plan and `docs/backlog/active.md`;
  do not change implementation paths here.
- Acceptance and verification: approved project-scoped environment variables and the
  16 KiB / 2 MiB / 30-day `createdAt` log contract with explicit `gap` event; run
  `pnpm docs:check` and `git diff --check`.
- Next action: none for the gate; implement the now-unblocked dependent slices in order.

### M6-ENV-VARS

- Status: complete; M6 remains active and this does not claim SSE, dashboard, or
  integrated M6 acceptance.
- Dependency: M6-PRODUCT-CONTRACT closed; completed after M6-QUERY-API in the sequential ledger.
- Objective and owned paths: project-shared encrypted persistence, names-only
  owner-scoped API, shared authenticated cipher, and worker-to-preview Secret/env
  injection. Bounds: 32 Kubernetes environment identifiers, 16,384 UTF-8 bytes per
  value, and 512 KiB aggregate plaintext per project Secret.
- Acceptance and verification: focused real PostgreSQL repository 1/1; real
  HTTP/PostgreSQL API 1/1; focused real kind injection test 1 passed (2 skipped,
  16.30s), proving same-project preview sharing, foreign-project isolation, ciphertext
  loading, Pod-only plaintext, no build/event exposure, and removal pruning Secret/envFrom.
  Full `pnpm check` passed: Biome 164 files; docs 169 links/53 files; Turbo 18/18;
  security 4/4, API unit 55/55, worker unit 166/166, DB integration 81/81, API
  integration 3/3, worker integration 5/5. Cleanup: users/projects/deployments/env rows
  0/0/0/0 and no managed namespaces. See [canonical evidence](../reports/session-2026-09-16-m6-env-vars.md).
- Implementation commit: `9d539481640e4a8734bfcee4a125718ab13661d6`.
- Next action: proceed sequentially to M6-SSE-API. Never include plaintext in
  build context/layers, event payloads, API responses, or logs.

### M6-LOG-DURABILITY

- Status: complete on 2026-09-16. The additive migration, transactional repository,
  worker streaming seam, and focused tests passed PostgreSQL and real rootless BuildKit
  acceptance. See the [verified evidence report](../reports/session-2026-09-16-m6-log-durability-checkpoint.md)
  and [hosted workflow run #14](https://github.com/EmirAkagunduz16/PreviewForge/actions/runs/35115043471).
- Dependency: M6-PRODUCT-CONTRACT closed; implement after M6-ENV-VARS in the sequential ledger.
- Objective and owned paths: stream bounded BuildKit output into ordered durable chunks
  via an additive Prisma `LogChunk.createdAt` migration, `packages/database/src/log-chunk-repository.ts`,
  database tests/exports, and worker build/log pipeline, configuration, and tests.
- Acceptance and verification: repository integration passed 6/6 on disposable PostgreSQL;
  full `pnpm check` passed (DB integration 87/87, API 3/3, worker M3 5/5, worker unit
  170/170). The rootless BuildKit hosted workflow built/pushed a real image and its
  `test:build:integration` passed 1/1, proving persisted output survives into a fresh
  repository instance; M4 integration passed 5/5. UTF-8 bounds, retention/eviction,
  empty-retention high-water gaps, stale-writer rejection, injected rollback, and terminal
  control stripping were verified. Migration maps Prisma `DateTime` to `TIMESTAMP(3)`;
  high-water means next sequence to allocate, and `createdAt` is not approximated by
  `emittedAt`.
- Implementation/evidence commit: `d6d3f9ff59d02bc5646a3d795dabbf72b95736c5`.
- Next action: M6-SSE-API is complete; proceed to M6-DASHBOARD. Resolve and rerun
  OPS-M5-HEALTH-ACCEPTANCE-DRIFT before integrated M6 acceptance.

### M6-SSE-API

- Status: complete on 2026-09-16; implementation commit
  `ef365b0113545a61cd87ebc66705590e54a5373b`. This closes the SSE API slice only; M6
  remains active.
- Dependency: M6-QUERY-API and M6-LOG-DURABILITY.
- Objective and owned paths: add authenticated owner-scoped replay/live HTTP SSE in
  `apps/api/src/live-output/`, API wiring/tests, and the owned log repository read seam.
- Acceptance and verification: real HTTP/PostgreSQL SSE acceptance passed 1/1 on freshly
  migrated disposable database `previewforge_m6_sse_20260916`. It proved initial status,
  cursor replay/live logs, status transition, reconnect, retention gap, heartbeat,
  unauthenticated 401, foreign/absent 404, and disconnect cleanup. Fixture users,
  projects, deployments, chunks, and outbox rows were 0/0/0/0/0; the database was
  dropped. `pnpm check` passed; see [the SSE report](../reports/session-2026-09-16-m6-sse-api.md).
- Next action: proceed sequentially to M6-DASHBOARD. Keep PostgreSQL authoritative and
  resolve/rerun OPS-M5-HEALTH-ACCEPTANCE-DRIFT before integrated M6 acceptance.

### M6-DASHBOARD

- Dependency: M6-QUERY-API, M6-ENV-VARS, and M6-SSE-API.
- Objective and owned paths: build the authenticated project/preview/history/detail UI,
  resumable logs, and write-only environment-key editor in `apps/web/app/`, the Next
  proxy config, and web tests; `.env.example` requires root reservation first.
- Acceptance and verification: authenticated browser/network checks prove owner-scoped
  views, ordered stages/history, refresh/reconnect, secret redaction, key mutations,
  errors/loading, and sign-out; run web tests and browser acceptance.
- Next action: start after all listed API/runtime slices are accepted and use same-origin
  routing without weakening the session cookie.

### M6-ACCEPTANCE

- Dependency: all preceding implementation slices, including the product-contract gate.
- Objective and owned paths: add integrated API/browser acceptance in
  `apps/api/src/m6.integration.test.ts` and an existing supported web harness only.
- Acceptance and verification: run `pnpm check` and the integrated disposable
  PostgreSQL/Kafka/BuildKit/registry/kind/Gateway/browser workflow; prove ownership,
  encrypted write-only runtime injection, durable logs/cursor reconnect, durable failure,
  and cleanup. Record unavailable dependencies as not-run, not mocked pass.
- Next action: after narrow gates pass, resolve OPS-M5-HEALTH-ACCEPTANCE-DRIFT and rerun
  `pnpm test:acceptance:m5` green before capturing full M6 runtime evidence and residue
  checks. The drift does not invalidate historical M5 evidence or focused M6 ENV-VARS proof.

## Sequential slices and acceptance matrix

| Slice | Risk | Stimulus | Observable oracle | Fault sensitivity | Runtime |
|---|---|---|---|---|---|
| M6-QUERY-API | Dashboard leaks another user's projects/previews or reports stale/incomplete history. | Authenticate two fixture users; query project list, active previews, project history, and a deployment detail with pagination. | Responses contain only owned projects; preview rows join the correct PR/current desired deployment; attempt history and stage/failure fields match PostgreSQL; non-owner and absent IDs are indistinguishable. | Remove owner predicate or weaken join and the cross-user real-DB case returns forbidden rows. | API + disposable PostgreSQL; route tests must assert HTTP and response bodies. |
| M6-PRODUCT-CONTRACT | Schema/API/UI become incompatible if the approved scope or retention contract is changed implicitly. | Apply the 2026-09-16 explicit user approval to the plan and dependent implementation contracts. | Project-shared variables, exact UTF-8 byte limits, createdAt age cutoff, oldest-first eviction, and named SSE `gap` event match the locked decision report. | Any implementation using preview-scoped values, different limits/cutoff, or silent cursor loss fails direct acceptance. | Human approval recorded; no runtime required for this completed gate. |
| M6-ENV-VARS | Secrets leak through read APIs, cross-owner writes, storage, Kafka/build args/logs, or wrong preview runtime. | Owner writes/replaces/deletes individual keys; non-owner attempts access; build and preview consume the configured values. | Database stores authenticated ciphertext bound to project/key; API lists names only; worker gets plaintext only after build and M5 applies it to the owned preview Secret; no value appears in response/outbox/build args/logs. | Deliberately return a value, remove AAD/owner checks, or pass variables into BuildKit and tests/acceptance fail. | API + worker + disposable PostgreSQL and real disposable kind for Pod environment/Secret proof. |
| M6-LOG-DURABILITY | Build output is lost, reordered, unbounded, duplicated, or rendered as executable markup. | Emit concurrent multi-chunk stdout/stderr/build events including oversized UTF-8 and terminal-control fixtures; restart/read from PostgreSQL. | Ordered unique sequences, approved chunk/retention caps, explicit truncation, safe text, and durable reload; build process output is streamed instead of buffered only until exit. | Disable cap, sequence lock/fence, or text escaping and limit/order/XSS assertions fail. | Disposable PostgreSQL; real BuildKit fixture for streamed progress and cleanup. |
| M6-SSE-API | Disconnects lose/duplicate log output, stale status is shown, or a stream bypasses ownership/auth. | Connect with/without a cursor, append logs and transition status during the stream, reconnect, use an expired cursor, and disconnect. | Authenticated owner receives current status, ordered replay after Last-Event-ID, live new chunks/status, explicit retention-gap marker when applicable, heartbeat, and prompt stream cleanup; cross-owner request is denied. | Removing Last-Event-ID forwarding caused the real HTTP/PostgreSQL test to receive sequence 1 instead of expected 2 and fail; restored forwarding passed. | Verified 2026-09-16 on fresh `previewforge_m6_sse_20260916`: real HTTP SSE 1/1, status/log replay, transition, gap, heartbeat, disconnect, zero fixtures; database dropped. |
| M6-DASHBOARD | Reload/reconnect loses state, project navigation hides active previews/history, or users can read stored secret values. | Sign in, load multiple projects/previews/attempts, open detail, refresh/disconnect/reconnect logs, update one env key and delete another. | Browser renders owned project/PR/deployment history and ordered stage states; live logs resume; env editor shows key names and write controls but never existing values; sign-out clears session. | Disable auth, cursor resume, secret redaction, or attempt ordering and browser/network assertions fail. | Web + API in local browser with real session and PostgreSQL-backed fixtures. |
| M6-ACCEPTANCE | Mock/unit success hides a broken authenticated end-to-end dashboard/log/secret workflow. | Run the integrated workflow: owner/non-owner queries, write-only env change, real digest preview, live build logs, reload/reconnect, and a durable failure. | Real API/DB/runtime/browser evidence verifies ownership, encrypted persistence, Pod injection, status/history, cursor continuity, failure redaction, and cleanup. | Remove an owner/SHA/cursor/secret guard temporarily or use a wrong cursor/owner; the direct acceptance target must fail before restoration. | Disposable PostgreSQL, Kafka/worker, existing local BuildKit/registry, disposable kind/Gateway, and browser; unavailable dependency is `not-run`, never replaced with a mock-only pass. |

## API and UI contract outline

- Query routes are authenticated, paginated, and owner-scoped. Suggested initial routes:
  `GET /api/projects`, `GET /api/projects/:projectId/previews`,
  `GET /api/projects/:projectId/deployments`, and
  `GET /api/deployments/:deploymentId`. Keep responses to explicit projections;
  never serialize Prisma rows wholesale. Use bounded page size (default 20, hard max
  100) and stable ordering by timestamps plus ID.
- The project overview shows imported repository/configuration, active PR previews,
  each preview's desired SHA/current deployment, and recent attempts. Deployment detail
  shows the enum-defined stage progression, terminal failure fields, timestamps,
  immutable digest identity where relevant, and retained logs. The UI does not mutate
  deployment state.
- Environment-variable routes are project-scoped and owner-scoped; the same project's
  values are shared by all PR previews. Expose key listing (names only), per-key
  create/replace, and per-key delete. Require
  same-origin mutation requests and validate bounded key/value input. Clear values from
  local component state after save and never repopulate them from server responses.
- `GET /api/deployments/:deploymentId/logs?after=<sequence>` pages retained durable
  output; `GET /api/deployments/:deploymentId/events` is SSE. SSE uses numeric log
  sequence IDs for `log` events, a freshly read deployment snapshot on connect/reconnect,
  an explicit `gap` event when Last-Event-ID predates retained data, and comment
  heartbeats. Status notifications are re-read from PostgreSQL, not dependent on a
  process-local fanout map or an unretained Kafka event.
- Enforce each log text chunk at <= 16,384 UTF-8 bytes and retained text at <= 2,097,152
  UTF-8 bytes per deployment. Evict the oldest chunks first for the total cap and expire
  chunks by `createdAt < now - 30 days`; update `LogChunk.createdAt` with the additive
  migration owned by M6-LOG-DURABILITY. Append sequences transactionally under the
  deployment row lock; if the worker lease is available at the append seam, fence stale
  worker writes by lease generation. Build output remains plain text and bounded before
  persistence. An expired `Last-Event-ID` produces `event: gap` with the oldest retained
  sequence, or the next sequence when nothing remains, so the client can reset/resume.
- The initial dashboard may use one project/deployment navigation and native
  `EventSource`; keep accessibility and useful empty/loading/error states. Do not add a
  frontend framework or authentication provider for M6.

## Exit checklist

- Authenticated owner-scoped project list and active preview/history/detail APIs pass
  real PostgreSQL integration tests, including cross-user isolation and pagination.
- Deployment status/stages use the shared transition contract; attempt history and
  failure metadata remain redacted and durable.
- Environment scope and log retention are locked by the 2026-09-16 approval. Environment
  values are encrypted at rest with authenticated project/key binding, write-only at
  the API boundary, injected only into the preview Pod, and absent from BuildKit/Kafka/
  API responses/logs.
- M6-LOG-DURABILITY and M6-SSE-API are complete: BuildKit output streams into bounded
  durable chunks; SSE resumes from cursor, marks retention gaps, refreshes status, emits
  heartbeat comments, and closes cleanly on disconnect.
- Browser refresh/reconnect preserves deployment status and retained history; secret
  reads remain redacted. The UI provides project list, active previews, attempt history,
  deployment detail/stages, live logs, and environment-key management.
- `pnpm check` passes. Critical query, write-only secret, cursor replay, and cross-owner
  cases run against the real disposable dependencies; no result is called end-to-end if
  BuildKit/kind/browser evidence was not exercised.

## Handoff record

```yaml
id: M6-PLAN
status: active
acceptance_ref: docs/plans/m6-dashboard-live-logs.md#Exit checklist
owned_paths: [docs/plans/m6-dashboard-live-logs.md, docs/backlog/active.md]
verification_command: pnpm docs:check; git diff --check
next_action: Implement M6-DASHBOARD next, then integrated acceptance; resolve OPS-M5-HEALTH-ACCEPTANCE-DRIFT before integrated acceptance. M6 remains active.
blocker: Product contract, ENV-VARS, LOG-DURABILITY, and SSE are closed. Dashboard and integrated acceptance remain unfinished; full M5 health acceptance must be repaired and rerun before M6 integrated acceptance.
acceptance: Owner-scoped dashboard/history, write-only encrypted environment management, bounded durable logs, and resumable SSE pass real acceptance.
evidence: Product policy is docs/reports/decision-2026-09-16-m6-product-contract.md. ENV-VARS evidence is docs/reports/session-2026-09-16-m6-env-vars.md. LOG-DURABILITY evidence is docs/reports/session-2026-09-16-m6-log-durability-checkpoint.md. SSE evidence is docs/reports/session-2026-09-16-m6-sse-api.md. Full M5 health acceptance drift and exact investigation are docs/reports/incident-2026-09-16-m5-health-acceptance-drift.md.
evidence_commit: ef365b0113545a61cd87ebc66705590e54a5373b
```
