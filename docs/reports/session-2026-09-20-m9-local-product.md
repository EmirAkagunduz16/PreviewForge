---
id: RPT-2026-09-20-m9-local-product
type: session
status: verified
date: 2026-09-20
vault_sync: pending
---

# M9 local product acceptance — 2026-09-20

## Result

M9 local product experience is complete. The final proof used the staged
rootless BuildKit socket, a real BuildKit worker, the disposable local
PostgreSQL/Kafka/registry services, kind with Envoy Gateway, the API/worker/web
runtime, the controlled GitHub fixture, and a CUA browser journey.

The last implementation gap was the worker's default health check. A local
preview health URL is now derived from the shared preview URL contract, so the
worker sends the preview hostname and loopback port to Envoy without a hidden
`PREVIEWFORGE_HEALTHCHECK_URL_TEMPLATE` setting. Explicit templates remain an
override for deployments that need one.

M10 remains separately blocked by the approved AWS cost boundary. No AWS
credential, account, or resource was used.

## Host and runtime evidence

- Staged runtime files under `/var/tmp/previewforge-buildkit` have the
  `previewforge-buildkit` owner and restricted modes. RootlessKit child
  namespace and UID/GID maps were verified.
- The authorized Unix socket is
  `/var/tmp/previewforge-buildkit/buildkitd.sock` with client group `emir` and
  mode `0660`. `buildctl debug workers` returned worker
  `mznlwmqkfsx16ehxgrx4yndop` with `linux/amd64`, `linux/amd64/v2`,
  `linux/amd64/v3`, and `linux/386`.
- `pnpm local:up` was rerun after the health URL fix without
  `PREVIEWFORGE_HEALTHCHECK_URL_TEMPLATE`; it reached the dashboard, API, and
  Gateway ready state and reported the registry endpoint `172.25.0.1:55000`.
- `pnpm local:status` reported API, web, worker, Gateway, registry,
  PostgreSQL, Kafka, BuildKit, and kind as ready. A second runtime start had
  already passed the idempotent supervisor check.

## Direct M9 journey

- `pnpm m9:fixture:check` passed: 3 webhook payloads, 11 journey stages, and
  the loopback GitHub fixture were present.
- A clean PR12 webhook was accepted with HTTP 201 and deployment
  `65c5c699-020b-4e6c-88ff-4a0cdb1a71c0`. PostgreSQL reached `READY` with
  environment `ab413eff-c47c-4c67-ac59-b05868147ebd` and immutable image
  digest
  `sha256:5a333f99688838043640cc73e5ff28e9c61376ea25b030678faf5d6499c6debe`.
- The real kind workload was `1/1 Running`, the Deployment was `1/1
  Available`, and the HTTPRoute reported `Accepted=True` and
  `ResolvedRefs=True`. The image reference used the immutable digest through
  the staged registry endpoint.
- Gateway probes returned the expected fixture response with the generated
  preview Host (`200`, `{"status":"ok","fixture":"m9-local-demo"}`) and
  `404 Not Found` for `wrong.preview.localhost`.
- The authenticated browser dashboard showed the owner project,
  `PR #12 ACTIVE`, `READY`, immutable digest, live BuildKit logs, and the
  `Open preview` link. Opening that link created a browser tab at the generated
  preview hostname, which rendered `PreviewForge M9 local demo fixture`.

## Delivery safety and cleanup

- Raw webhook controls passed: invalid signature `401`; the same delivery
  returned `duplicate=false` then `duplicate=true`; an older payload returned
  `stale=true`.
- PR9, PR10, PR11, and PR12 close deliveries produced completed deletion
  requests. The final PR12 request completed at `2026-09-20 18:26:06.199` and
  no namespace with `previewforge.dev/managed=true` remained.
- `pnpm local:down` stopped the owned runtime. A subsequent status check
  reported `stopped`, `/var/tmp/previewforge-local` was absent, and the
  user-owned BuildKit worker remained available on its dedicated socket.
- PostgreSQL retains the product's deployment and webhook history for the
  dashboard; cleanup is represented by completed deletion requests and the
  absence of managed Kubernetes resources. No credentials or secret values
  were written to the report.

## Repository verification

- `pnpm --filter @previewforge/contracts build` passed.
- `pnpm --filter @previewforge/contracts test` passed: 4 files / 34 tests.
- `pnpm --filter @previewforge/worker typecheck` passed.
- `pnpm exec biome check ...` and `git diff --check` passed for the final code
  slice before documentation updates.
- The final root `pnpm check` passed: Biome/docs checks, Turbo 21/21, database
  integration 14 files/99 tests, API integration 6 files/8 tests, and worker
  integration 1 file/5 tests. `pnpm docs:check` and `git diff --check` also
  passed after the final documentation edits.

## Changed implementation

- `packages/contracts/src/preview-url.ts` adds the shared health-check URL
  helper and contract tests.
- `apps/worker/src/preview-url.ts` re-exports the helper.
- `apps/worker/src/main.ts` uses the configured URL contract as the default
  health-check target while preserving the explicit template override.

Related plan, backlog, and roadmap entries are updated with this report. The
VictusOS mirror remains `vault_sync: pending` until a separate vault sync is
performed.
