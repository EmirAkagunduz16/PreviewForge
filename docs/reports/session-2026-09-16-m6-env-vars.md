---
id: RPT-2026-09-16-m6-env-vars
type: session
status: verified
date: 2026-09-16
vault_sync: synced
---

# M6 project-shared environment variables

M6-ENV-VARS is complete. M6 as a whole remains active; LOG-DURABILITY, SSE, the
dashboard, and integrated acceptance are still unfinished. The implementation is
recorded in commit `9d539481640e4a8734bfcee4a125718ab13661d6`; push is recorded
separately from this evidence report.

## Contract and safety boundary

Environment variables are project-scoped and shared by every PR preview belonging to
the project. The additive model stores only authenticated ciphertext bound to
project/key; owner-scoped API mutations are write-only and public key responses contain
exactly the key name. Limits are at most 32 Kubernetes environment identifiers, 16,384
UTF-8 bytes per value, and 512 KiB aggregate plaintext per project Secret. Plaintext is
loaded/decrypted by the worker after the build and supplied only through the owned
preview Secret/Pod environment. It is excluded from build context/layers, event payloads,
API responses, and logs. Removing all values prunes the Secret and `envFrom` reference.

## Reproducible evidence

- Migration `20260916120000_m6_project_environment_variables` applied with
  `prisma migrate deploy` to the disposable DB; all seven migrations succeeded.
- Focused real PostgreSQL repository test: 1 file / 1 test passed. Two distinct
  `PullRequest` rows (numbers 41 and 42, different head SHAs and OPEN/CLOSED states) in
  the same project each have a `PreviewEnvironment`; both independently load through
  `listEncryptedByProjectId(context.projectId)` and decrypt to exactly
  `{ TOKEN: "replaced" }`. A foreign project resolves none. Ciphertext-at-rest, AAD
  binding, cascade, and cleanup were verified.
- Focused real HTTP/PostgreSQL API test: 1/1 passed, asserting exact key-only responses,
  auth/origin/owner guards, write-only replace/delete, missing/foreign normalization,
  bounds, and secret redaction.
- Real kind command
  `pnpm --filter @previewforge/worker exec vitest run src/m5.acceptance.test.ts -t 'reconciles an owned environment Secret...'`
  passed 1 test (2 skipped) in 16.30s. The persisted ciphertext went through the worker
  loader; Pod/Secret received the value while build/event observations did not; removal
  pruned Secret/envFrom.
- Full `pnpm check` exited 0: Biome 164 files; docs 169 links/53 files; context
  consistency 7 milestones/6 plans/4 active; Turbo 18/18 across 6 packages; security
  4/4, API unit 55/55, worker unit 166/166, DB integration 81/81, API integration 3/3,
  worker integration 5/5.
- Cleanup left users/projects/deployments/project environment variables at 0/0/0/0 and
  no managed namespaces.

## Separate M5 acceptance drift

The full `pnpm test:acceptance:m5` target was run twice; each run passed 2/3 tests and
failed the legacy health fixture at `apps/worker/src/m5.acceptance.test.ts:209`:
expected durable nonretryable `HEALTHCHECK_FAILED`, observed retryable
`HEALTHCHECK_TIMEOUT`. Do not loosen this expectation or claim the full M5 target is
currently green. The focused M6 ENV-VARS kind test passed and cleanup remained zero.
The exact next investigation and required rerun are tracked in the
[M5 health acceptance drift incident](incident-2026-09-16-m5-health-acceptance-drift.md).
This does not invalidate historical M5 evidence or this focused M6 slice; resolve and
reverify before integrated M6 acceptance.

## Next action

Proceed sequentially to M6-LOG-DURABILITY under the locked 16 KiB/chunk, 2 MiB per
deployment, 30-day `createdAt`, oldest-first eviction and explicit SSE gap contract.
Before integrated M6 acceptance, resolve the M5 drift and rerun the full real M5 target.
