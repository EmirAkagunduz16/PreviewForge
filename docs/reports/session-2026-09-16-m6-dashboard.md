# M6-DASHBOARD completion evidence — 2026-09-16

Status: verified slice completion. M6 remains active; integrated M6 acceptance is still
gated by the open M5 health-classification drift and the full worker/runtime workflow.

## Scope delivered

- Replaced the foundation page with an authenticated, owner-scoped dashboard for projects,
  active previews, deployment history, deployment detail, ordered stage states, failure
  projections, and immutable image digest display.
- Added a same-origin Next.js `/api/:path*` rewrite controlled by
  `PREVIEWFORGE_API_ORIGIN`; local OAuth/session configuration now uses the browser origin
  (`PUBLIC_BASE_URL=http://localhost:3000`) so the HttpOnly SameSite=Lax cookie survives the
  proxy callback.
- Added a fetch-based SSE reader that sends `Last-Event-ID`, persists a bounded log cache in
  session storage, reconnects with bounded backoff, renders logs as text, and visibly resets
  on a retention `gap` event.
- Added project-scoped write-only environment-key controls. The dashboard only receives and
  renders key names; values are cleared after save and are never rendered or returned by the
  list response. Sign-in, loading, empty, error, and sign-out states are covered.

## Runtime acceptance

Using the local PostgreSQL/Kafka dependencies, a disposable GitHub OAuth stub, and a real
Next.js + NestJS HTTP stack:

- The unauthenticated browser/API proxy request returned `401`.
- The browser completed the OAuth callback/session-cookie flow, then loaded a real
  PostgreSQL-backed project, PR preview, deployment history/detail, ordered stages, and two
  durable log chunks through `/api`.
- Refresh reloaded the durable log output; the fetch reader sends the persisted cursor on
  subsequent reconnects and visibly handles server `gap` frames.
- `PUT` created a new environment key and `DELETE` removed it. The browser DOM showed the key
  name and write-only controls but never the submitted value.
- Sign-out called `/api/auth/github/logout`; the subsequent reload returned to the GitHub
  sign-in CTA and the project endpoint returned `401`.
- Cleanup verified zero fixture users, projects, deployments, log chunks, and environment
  variables: `0/0/0/0/0`.

## Verification

- `pnpm --filter @previewforge/web typecheck` — passed.
- `pnpm --filter @previewforge/web test` — 1 file, 2 tests passed.
- `pnpm --filter @previewforge/web build` — Next production build passed.
- `pnpm docs:check` — 192 local links and context consistency passed.
- `DATABASE_URL=... KAFKA_BROKERS=... pnpm check` — passed: Biome 175 files, docs checks,
  Turbo 18/18, database integration 87/87, API integration 4/4, worker integration 5/5,
  and all unit/typecheck/build tasks.

## Changed paths

`apps/web/app/page.tsx`, `apps/web/app/styles.css`, `apps/web/app/sse.ts`,
`apps/web/app/page.test.ts`, `apps/web/next.config.ts`, `.env.example`, and delivery records.

No API or database production contract was changed in this slice. The existing `.codex/`
untracked directory remains protected and unrelated.

## Next action and limits

M6-ACCEPTANCE remains queued until `OPS-M5-HEALTH-ACCEPTANCE-DRIFT` is resolved and the
complete owner/non-owner, worker, BuildKit, Kubernetes, Gateway, log replay, failure, and
residue workflow is rerun. This report does not claim integrated M6 completion.

