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
  approved bounded-retention implementation requires an additional index/field.
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

## Product decisions that block dependent slices

Two user-visible limits are not specified by the MVP, ADRs, or current schema and must
not be silently guessed:

1. Environment-variable scope: project-wide values shared by every PR preview for a
   project, or values scoped independently to each preview environment. Recommendation
   for confirmation: project-wide, because the roadmap places settings with projects
   and the current UI promise is generic write-only environment-variable management.
   The selected scope changes the storage key, API routes, editor, and worker lookup.
2. Log retention: maximum UTF-8 bytes per stored chunk, total retained bytes/chunks per
   deployment, and/or age-based retention, including how truncation is presented.
   Select an explicit finite budget and document it before implementing the writer or
   cursor-gap behavior. The existing schema alone does not define this product policy.

`M6-PRODUCT-CONTRACT` is a hard gate for environment storage/runtime and log persistence.
The query API slice can proceed first. If either decision remains unresolved when the
sequential implementer reaches its dependent slice, stop there and request direction;
do not encode a guessed scope or retention contract.

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
| Gate | M6-PRODUCT-CONTRACT | `docs/plans/m6-dashboard-live-logs.md`, `docs/backlog/active.md` | Query API design review; user/root decision |
| 2 | M6-ENV-VARS | Prisma schema + one migration, `packages/database/src/project-environment-repository.ts`, `packages/security/`, API environment-variable module/config/tests, worker config/runtime integration/tests, M5 Kubernetes environment seam | M6-PRODUCT-CONTRACT |
| 3 | M6-LOG-DURABILITY | `packages/database/src/log-chunk-repository.ts`, database tests/exports, worker BuildKit log streaming/pipeline/config/tests | M6-PRODUCT-CONTRACT |
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
- Next action: implement this slice, then review its query contract before the product gate.

### M6-PRODUCT-CONTRACT

- Dependency: query API design review; explicit user/root decision. This is a hard gate
  for both secret storage/runtime and log persistence.
- Objective and owned paths: record approved choices in this plan and `docs/backlog/active.md`;
  do not change implementation paths here.
- Acceptance and verification: specify project-wide versus preview-scoped variables,
  finite per-chunk/total/age log limits, and truncation/gap behavior; run
  `pnpm docs:check` and `git diff --check`. Until then, dependent entries remain blocked.
- Next action: obtain the two decisions; do not infer them from the schema or UI placement.

### M6-ENV-VARS

- Dependency: approved M6-PRODUCT-CONTRACT.
- Objective and owned paths: add encrypted owner-scoped persistence, API write-only
  key management, shared cipher support, and worker-to-preview injection. Scope is
  Prisma/migration, database repository, `packages/security/`, API environment module,
  worker config/runtime/tests, and the M5 Kubernetes environment seam.
- Acceptance and verification: disposable PostgreSQL/API/worker tests plus real kind
  prove ciphertext binding, redacted reads, and Pod-only plaintext injection; run the
  database, API, and worker tests before runtime acceptance.
- Next action: wait for the approved variable scope, then implement without exposing
  values to BuildKit, events, responses, or logs.

### M6-LOG-DURABILITY

- Dependency: approved M6-PRODUCT-CONTRACT.
- Objective and owned paths: stream bounded BuildKit output into ordered durable chunks
  via `packages/database/src/log-chunk-repository.ts` and worker build/log pipeline,
  configuration, exports, and tests.
- Acceptance and verification: disposable PostgreSQL and a real BuildKit streaming
  fixture prove ordered restart-safe chunks, approved finite retention, explicit
  truncation, and safe plain-text output; run database integration and worker tests.
- Next action: wait for approved limits, then implement transactional sequence allocation
  and the specified retention behavior.

### M6-SSE-API

- Dependency: M6-QUERY-API and M6-LOG-DURABILITY.
- Objective and owned paths: add authenticated owner-scoped replay/live HTTP SSE in
  `apps/api/src/live-output/`, API wiring/tests, and the owned log repository read seam.
- Acceptance and verification: a real HTTP stream over disposable PostgreSQL proves
  cursor replay, refreshed status, gap signaling, cross-owner denial, reconnect, and
  disconnect cleanup; run API tests plus that integration test.
- Next action: implement only after both dependencies pass; preserve native SSE and the
  numeric durable cursor contract.

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
- Next action: after narrow gates pass, capture the complete runtime evidence and residue
  checks for M6 closure.

## Sequential slices and acceptance matrix

| Slice | Risk | Stimulus | Observable oracle | Fault sensitivity | Runtime |
|---|---|---|---|---|---|
| M6-QUERY-API | Dashboard leaks another user's projects/previews or reports stale/incomplete history. | Authenticate two fixture users; query project list, active previews, project history, and a deployment detail with pagination. | Responses contain only owned projects; preview rows join the correct PR/current desired deployment; attempt history and stage/failure fields match PostgreSQL; non-owner and absent IDs are indistinguishable. | Remove owner predicate or weaken join and the cross-user real-DB case returns forbidden rows. | API + disposable PostgreSQL; route tests must assert HTTP and response bodies. |
| M6-PRODUCT-CONTRACT | Schema/API/UI become incompatible because variable scope or log retention is guessed. | Review explicit alternatives and record the owner-approved choice in this plan before dependent implementation starts. | Scope and finite log chunk/retention/gap policy are written as locked decisions; otherwise dependent entries remain blocked with exact next action. | Attempting implementation while either field is unresolved fails the handoff gate. | Human product decision; no runtime. |
| M6-ENV-VARS | Secrets leak through read APIs, cross-owner writes, storage, Kafka/build args/logs, or wrong preview runtime. | Owner writes/replaces/deletes individual keys; non-owner attempts access; build and preview consume the configured values. | Database stores authenticated ciphertext bound to project/key; API lists names only; worker gets plaintext only after build and M5 applies it to the owned preview Secret; no value appears in response/outbox/build args/logs. | Deliberately return a value, remove AAD/owner checks, or pass variables into BuildKit and tests/acceptance fail. | API + worker + disposable PostgreSQL and real disposable kind for Pod environment/Secret proof. |
| M6-LOG-DURABILITY | Build output is lost, reordered, unbounded, duplicated, or rendered as executable markup. | Emit concurrent multi-chunk stdout/stderr/build events including oversized UTF-8 and terminal-control fixtures; restart/read from PostgreSQL. | Ordered unique sequences, approved chunk/retention caps, explicit truncation, safe text, and durable reload; build process output is streamed instead of buffered only until exit. | Disable cap, sequence lock/fence, or text escaping and limit/order/XSS assertions fail. | Disposable PostgreSQL; real BuildKit fixture for streamed progress and cleanup. |
| M6-SSE-API | Disconnects lose/duplicate log output, stale status is shown, or a stream bypasses ownership/auth. | Connect with/without a cursor, append logs and transition status during the stream, reconnect, use an expired cursor, and disconnect. | Authenticated owner receives current status, ordered replay after Last-Event-ID, live new chunks/status, explicit retention-gap marker when applicable, heartbeat, and prompt stream cleanup; cross-owner request is denied. | Remove cursor filtering or owner check, or omit DB status re-read on reconnect; integration oracle fails. | API over disposable PostgreSQL; real HTTP SSE stream (not only mocked Observable). |
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
- Environment-variable routes are owner-scoped. Once the scope decision is confirmed,
  expose key listing (names only), per-key create/replace, and per-key delete. Require
  same-origin mutation requests and validate bounded key/value input. Clear values from
  local component state after save and never repopulate them from server responses.
- `GET /api/deployments/:deploymentId/logs?after=<sequence>` pages retained durable
  output; `GET /api/deployments/:deploymentId/events` is SSE. SSE uses numeric log
  sequence IDs for `log` events, a freshly read deployment snapshot on connect/reconnect,
  a documented `gap`/`reset` event when a cursor precedes retained data, and comment
  heartbeats. Status notifications are re-read from PostgreSQL, not dependent on a
  process-local fanout map or an unretained Kafka event.
- Limit log chunks and total retention according to the approved M6 product budget.
  Append sequences transactionally under the deployment row lock; if the worker lease
  is available at the append seam, fence stale worker writes by lease generation. Build
  output remains plain text and bounded before persistence.
- The initial dashboard may use one project/deployment navigation and native
  `EventSource`; keep accessibility and useful empty/loading/error states. Do not add a
  frontend framework or authentication provider for M6.

## Exit checklist

- Authenticated owner-scoped project list and active preview/history/detail APIs pass
  real PostgreSQL integration tests, including cross-user isolation and pagination.
- Deployment status/stages use the shared transition contract; attempt history and
  failure metadata remain redacted and durable.
- Environment scope and log retention are approved before dependent work. Environment
  values are encrypted at rest with authenticated project/key binding, write-only at
  the API boundary, injected only into the preview Pod, and absent from BuildKit/Kafka/
  API responses/logs.
- Log source streams worker BuildKit progress into ordered durable chunks with approved
  finite bounds; SSE resumes from cursor, marks retention gaps, refreshes status, and
  closes cleanly on disconnect.
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
next_action: Resolve M6-PRODUCT-CONTRACT decisions before M6-ENV-VARS or M6-LOG-DURABILITY begins.
blocker: Environment-variable scope and finite log retention budget are not specified in existing MVP/ADR/schema.
acceptance: Owner-scoped dashboard/history, write-only encrypted environment management, bounded durable logs, and resumable SSE pass real acceptance.
evidence: Planning baseline HEAD 165d06c4fdc797de89c765e483d776742a95446a; no implementation/runtime evidence claimed.
evidence_commit: not-run
```
