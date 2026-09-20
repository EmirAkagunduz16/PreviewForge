---
id: RPT-2026-09-18-m9-local-routing-checkpoint
type: session
status: checkpoint
date: 2026-09-18
vault_sync: not yet synced
---

# M9 local routing implementation checkpoint — 2026-09-18

## Result

The local preview URL is now one shared contract across the worker, API,
dashboard, and GitHub Check path. A validated optional
`PREVIEWFORGE_GATEWAY_LOCAL_PORT` is appended only to the user-facing URL; the
environment-derived hostname remains portless and continues to be the
HTTPRoute identity. Local defaults use `preview.localhost`, which resolves to
loopback in browsers without a hosts-file entry.

Production configuration remains fail-closed: it requires a public HTTPS
domain, rejects local domains, and rejects a local Gateway port. Base-domain
validation still rejects credentials and malformed authority-shaped input.

## Changed surface

- `packages/contracts/src/preview-url.ts`: shared URL configuration, port
  validation, hostname identity, and production guard.
- `apps/worker/src/preview-url.ts`: stable worker re-export of the shared
  contract; Kubernetes renderer and local route documentation now use the
  resolvable local domain.
- `apps/worker/src/github-checks/`: READY Check output uses the same local URL,
  including the configured port.
- `apps/api/src/app.module.ts` and `apps/api/src/dashboard/dashboard.service.ts`:
  dashboard projections expose the same URL at environment, deployment, and
  current-deployment boundaries.
- `apps/web/app/page.tsx` and `apps/web/app/styles.css`: READY deployment detail
  includes an explicit `Open preview` link.
- M9 plan/backlog, README, Gateway forwarding guidance, and this report now
  describe the portless route hostname versus the clickable loopback URL.

## Verification

Passed:

- `pnpm --filter @previewforge/contracts test` — 4 files, 33 tests passed.
- `pnpm --filter @previewforge/contracts build` and `typecheck`.
- `pnpm --filter @previewforge/worker exec vitest run src/github-checks/coordinator.test.ts src/preview-url.test.ts` — 2 files, 11 tests passed.
- `pnpm --filter @previewforge/api exec vitest run src/dashboard/dashboard.service.test.ts` — 1 file, 7 tests passed.
- `pnpm --filter @previewforge/api typecheck` and `build`.
- `pnpm --filter @previewforge/web test` — 1 file, 3 tests passed.
- `pnpm --filter @previewforge/web typecheck` and `build`.
- Biome on all changed routing implementation files.

Not run:

- Real kind/Envoy/browser routing acceptance: the host still fails the local
  Docker context preflight and does not have the accepted dedicated rootless
  BuildKit boundary. No READY workload, Host-header negative probe, or browser
  navigation claim is made here.
- Full integration gate remains environment-dependent on PostgreSQL/Kafka and
  controlled GitHub fixtures.

## Next action

Keep M9-LOCAL-ROUTING in progress until a disposable local runtime is available
and proves immutable-digest READY routing, the wrong-host negative result, and
browser navigation to the emitted `preview.localhost:<port>` URL. M9-LOCAL-DEMO
remains queued behind the real runtime acceptance of the three foundations.

No real GitHub credential, AWS resource, privileged workload, Docker socket
mount, host networking, or global security setting was introduced.
