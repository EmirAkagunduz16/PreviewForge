# M2 execution plan — GitHub App vertical slice

Status: active
Owner: PreviewForge delivery
Baseline before planning: `e499850dd94e631d558934c5f5d34bffd7f41eb9`, clean worktree
Sources: [delivery roadmap](../delivery/roadmap.md), [MVP scope](../product/mvp-scope.md), [system design](../architecture/system-design.md), [ADR 0002](../architecture/decisions/0002-postgres-outbox-and-kafka.md)

## Outcome

Deliver the first GitHub-facing control-plane slice: GitHub App web-flow sign-in, verified installation ownership, authorized repository discovery/import, and raw-byte pull-request webhook handling with durable delivery deduplication. Use PostgreSQL as the source of truth and reuse M1's desired-SHA and transactional-outbox invariants.

## Locked decisions

- Use the GitHub App web application flow with one-time PostgreSQL state, PKCE S256, an HttpOnly `SameSite=Lax` binding cookie, and opaque PostgreSQL-backed local sessions.
- Store GitHub user access/refresh tokens only as versioned AES-256-GCM ciphertext using `ENCRYPTION_KEY`; never store or log plaintext. Support refresh metadata when GitHub returns it and otherwise require sign-in again after expiry.
- Do not enable GitHub's OAuth-during-install option. Use a separate authenticated installation start plus Setup URL callback, verify the claimed installation with both the user token and App identity, and reject ownership transfer.
- Keep single verified owner semantics for an installation in the MVP. Multi-user organization membership and enterprise RBAC remain out of scope.
- Use immutable GitHub numeric IDs as strings at HTTP/event boundaries and PostgreSQL `BIGINT` columns in persistence. Repository full name/login remain display metadata.
- List repositories through the user-access-token endpoint so results are scoped by both user and installation access. Use installation tokens only for installation-owned repository content checks.
- Use Node 22 `fetch` and `node:crypto`; do not add Redis or a broad SDK unless implementation evidence shows the narrow adapter is insufficient.
- M2 `closed` handling persists `environment.deletion-requested.v1`; it does not touch Kubernetes.

## Dependency waves

| Wave | ID | Work | Depends on |
|---:|---|---|---|
| 1 | M2-CONTRACTS | Strict GitHub/auth/import/webhook boundary and event contracts. | M1 |
| 1 | M2-DATA | M2 schema and migration for sessions, OAuth state, encrypted credentials, immutable GitHub IDs, project config, webhook ordering, and deletion intent state. | M1 |
| 1 | M2-FOUNDATION | GitHub configuration, credential cipher, HTTP adapter/JWT primitives, raw-body bootstrap, cookies, and database lifecycle wiring. | M1 |
| 2 | M2-AUTH-INSTALL | Sign-in callback, local sessions, installation start/setup, and first-owner idempotency. | M2-CONTRACTS, M2-DATA, M2-FOUNDATION |
| 2 | M2-IMPORT | Paginated user-authorized repository listing and idempotent Dockerfile project import. | M2-CONTRACTS, M2-DATA, M2-FOUNDATION, M2-AUTH-INSTALL |
| 2 | M2-WEBHOOK | Raw-byte HMAC verification, delivery conflict/dedupe, PR desired-state mutation, deployment/deletion outbox intent. | M2-CONTRACTS, M2-DATA, M2-FOUNDATION, M1-OUTBOX |
| 3 | M2-ACCEPTANCE | Root-owned wiring and real Nest HTTP + PostgreSQL + controlled GitHub HTTP acceptance suite. | all M2 slices |

## Ownership ledger

Implementation baseline will be the clean plan commit. Pre-existing dirty paths are protected.

```yaml
root_owned:
  - package.json
  - pnpm-lock.yaml
  - apps/api/package.json
  - apps/api/src/app.module.ts
  - packages/contracts/src/index.ts
  - packages/database/src/index.ts
  - docs/**
  - .env.example
  - integration wiring and final acceptance fixtures
wave_1:
  M2-CONTRACTS:
    - packages/contracts/src/github.ts
    - packages/contracts/test/github.test.ts
  M2-DATA:
    - packages/database/prisma/schema.prisma
    - packages/database/prisma/migrations/20260913*_m2_github_app/**
    - packages/database/test/m2-migration.integration.test.ts
  M2-FOUNDATION:
    - apps/api/src/config.ts
    - apps/api/src/config.test.ts
    - apps/api/src/github/github-client.ts
    - apps/api/src/github/github-client.test.ts
    - apps/api/src/security/**
    - apps/api/src/database/**
    - apps/api/src/application.ts
wave_2:
  M2-AUTH-INSTALL:
    - apps/api/src/auth/**
    - apps/api/src/installations/**
    - packages/database/src/auth-installation-repository.ts
    - packages/database/test/auth-installation-repository.integration.test.ts
  M2-IMPORT:
    - apps/api/src/projects/**
    - packages/database/src/project-repository.ts
    - packages/database/test/project-repository.integration.test.ts
  M2-WEBHOOK:
    - apps/api/src/webhooks/**
    - packages/database/src/webhook-repository.ts
    - packages/database/test/webhook-repository.integration.test.ts
```

No concurrent agent may edit a root-owned path or another slice's path. An agent that needs an unowned/shared file must stop and report it. Root quiesces each wave and checks changed files against this ledger before integration.

## Acceptance matrix

| ID | Risk | Realistic stimulus | Observable oracle | Required fault sensitivity | Runtime |
|---|---|---|---|---|---|
| M2-CONTRACTS | Untrusted GitHub/import fields cross the boundary or secrets survive normalization. | Malformed headers/payloads, unknown fields, invalid SHA/IDs/path/port/health URL. | Strict safe DTO/event or stable rejection; unknown/secret fields absent. | A permissive schema or removed path guard makes target tests fail. | Contract tests. |
| M2-DATA | Identity, token, source ordering, or project settings cannot be stored safely/idempotently. | Apply migration to empty DB, insert max GitHub IDs, duplicate identities, ciphertext metadata, source timestamps. | Constraints reject conflicts; no plaintext credential column; second migrate is no-op. | Removing a canonical unique/FK constraint fails a PostgreSQL test. | Disposable PostgreSQL 18. |
| M2-FOUNDATION | Secrets leak, GitHub tokens/JWTs are malformed, wrong raw body/context is used. | Known crypto vectors, token-like logs/errors, fake GitHub responses, compact vs reserialized bytes. | Correct cipher/JWT/request behavior, redacted errors, raw buffer preserved. | Disable authentication/redaction/raw-body capture and the direct target fails. | Real Nest HTTP plus controlled GitHub HTTP fixture. |
| M2-AUTH-INSTALL | Login CSRF/replay or spoofed installation transfers ownership. | Valid/wrong/replayed/expired state, PKCE error, repeated/concurrent setup, claimed installation inaccessible to user. | One user/session/credential and one installation; invalid attempts write nothing; owner never changes. | Disable state consumption or user-installation verification and direct acceptance fails. | Real Nest HTTP, PostgreSQL, controlled GitHub HTTP fixture. |
| M2-IMPORT | Unauthorized/renamed repository is imported, pagination truncates, or unsafe config persists. | Multi-page list, pull=false, missing/directory Dockerfile, path traversal, repeated/concurrent import, renamed repository with same numeric ID. | Only authorized repos; one canonical project; validated Dockerfile/port/health; safe errors. | Disable pagination/permission/unique/path checks and targets fail. | Real Nest HTTP, PostgreSQL, controlled GitHub HTTP fixture. |
| M2-WEBHOOK | Parsed-body HMAC, duplicate delivery, partial transaction, or out-of-order event corrupts desired state. | Signature over exact compact bytes; altered whitespace with old signature; 12 concurrent duplicates; conflicting same delivery ID; injected mid-transaction failure; newer close followed by older open. | Rejected signatures create zero rows; exact duplicate creates one delivery/deployment/event; conflict creates no second mutation; rollback leaves no residue; stale events cannot reopen; close emits one deletion request. | Deliberately verify reserialized JSON and disable dedupe/source-time guard in turn; critical target must fail, then pass after restoration. | Real Nest HTTP and PostgreSQL 18. |
| M2-ACCEPTANCE | Passing narrow tests hide broken integration or wrong test discovery. | Run critical files directly, then repository gate against the verified local DB/context. | Expected files/counts run; HTTP/database state agrees; `pnpm check` passes after final integration. | At least one deliberate fault per critical security/durability/idempotency boundary is detected and restoration is proven. | `default` Docker context, local disposable PostgreSQL and fake GitHub HTTP server. |

## GitHub App permission gate

- Repository metadata: read.
- Repository contents: read.
- Pull requests: read; subscribe only to required pull-request and installation lifecycle events.
- Do not request repository write/admin, checks write (M7), Actions, secrets, organization administration, or broad OAuth scopes.
- Never assume installation/user tokens have a fixed length. Installation access tokens are ephemeral and are not persisted.

## Milestone exit checklist

- Sign-in establishes an authenticated local session keyed by immutable GitHub user ID.
- Setup callback proves the installation belongs to the authenticated user and is the configured App installation.
- Repository listing follows safe GitHub-origin pagination and import revalidates access plus Dockerfile type.
- `opened`, `reopened`, `synchronize`, and `closed` are processed over a verified raw request body with durable delivery dedupe and source-order guard.
- Duplicate delivery creates no duplicate deployment; close persists a deletion request only.
- Credentials remain encrypted/redacted; API responses never expose them.
- Root evidence packet records final commit/tree, exact commands, safe runtime identity, expected/observed test counts, changed files, and adversarial results.
- No Kafka relay/consumer (M3), build/BuildKit (M4), Kubernetes (M5), dashboard/SSE (M6), checks/cleanup execution (M7), Redis, or cloud deployment is introduced.

## Official references

- [GitHub App user access token web flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [GitHub App Setup URL](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url)
- [GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [Installation repositories](https://docs.github.com/en/rest/apps/installations)
- [REST pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)
- [Repository contents](https://docs.github.com/en/rest/repos/contents#get-repository-content)
- [Webhook signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [Webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)

## Definition of done

All M2 slices are archived with root-run evidence after final integration. Controlled external HTTP fixtures and real PostgreSQL/Nest boundaries pass, deliberate faults are detected, `pnpm check` passes, and the repository is clean. Live GitHub credentials are not required for local acceptance; live installation verification remains a separate explicit external check.
