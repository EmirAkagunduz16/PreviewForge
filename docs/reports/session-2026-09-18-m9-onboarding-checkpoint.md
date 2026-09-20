# M9 onboarding implementation checkpoint — 2026-09-18

## Scope

This checkpoint covers the local browser path from an authenticated dashboard to
an imported project. It is an implementation checkpoint, not the M9 onboarding
acceptance record.

## Implemented

- Added owner-scoped `GET /api/installations/github` discovery. The response
  contains only the GitHub installation id, account login, and account type;
  internal owner ids and credentials stay out of the response.
- Connected the dashboard to installation discovery, the existing repository
  listing endpoint, and the project import endpoint. The browser now shows
  explicit sign-in, local API unavailable, GitHub setup incomplete, empty
  repository, permission, validation, and import-error states.
- Added the supported v1 import controls: repository, Dockerfile path,
  container port, and health path. A successful import reloads the project
  dashboard without a manual refresh or copied installation id.
- Preserved stable safe domain error codes for import failures in the public
  API envelope.

## Verification

Passed:

- `pnpm --filter @previewforge/api exec vitest run src/auth/auth.service.test.ts src/installations/installations.controller.test.ts src/api-exception.filter.test.ts src/projects/project.service.test.ts`
- `pnpm --filter @previewforge/web exec vitest run app/page.test.ts`
- `pnpm --filter @previewforge/database build`
- `pnpm --filter @previewforge/api typecheck`
- `pnpm --filter @previewforge/web typecheck`
- `pnpm --filter @previewforge/database typecheck`
- `pnpm --filter @previewforge/api build`
- `pnpm --filter @previewforge/web build`
- `pnpm exec biome check` on the changed onboarding/API/database files
- `git diff --check`

Not run:

- direct HTTP/PostgreSQL integration and controlled-GitHub browser acceptance;
  the local runtime still cannot pass its Docker/rootless BuildKit host
  preflight, and no fixture acceptance run was claimed.
- `pnpm check` reached all 21 Turbo typecheck/test/build tasks successfully, but
  its final integration stage stopped because `DATABASE_URL` is not configured
  in this host environment.

## Next action

Keep M9-ONBOARDING in progress until the controlled fixture proves sign-in,
installation callback, owner isolation, repository discovery, successful and
duplicate import, inaccessible repository rejection, and safe browser errors.
