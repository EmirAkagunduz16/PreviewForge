---
id: RPT-2026-09-16-m5-health-acceptance-drift
type: incident
status: open
date: 2026-09-16
vault_sync: synced
---

# M5 full acceptance health-classification drift

## Symptom and evidence

The full `pnpm test:acceptance:m5` target was run twice against the real disposable
environment. Both runs passed 2/3 tests and failed the health fixture at
`apps/worker/src/m5.acceptance.test.ts:209`: the oracle expects a durable nonretryable
`HEALTHCHECK_FAILED`, but the observed classification is retryable
`HEALTHCHECK_TIMEOUT`. The focused M6 environment Secret kind test passed; fixture
cleanup remained users/projects/deployments/environment rows 0/0/0/0 with no managed
namespaces.

## Current assessment

Root cause is unresolved. Do not weaken the expected `HEALTHCHECK_FAILED` outcome or
represent the full M5 acceptance target as green. This repeatable drift does not erase
historical M5 completion evidence and does not invalidate the independently passing
focused M6 ENV-VARS runtime proof. It is a non-blocking operational follow-up for M5
history but a prerequisite to integrated M6 acceptance.

## Required investigation and acceptance

Inspect the health fixture and rollout path around
`apps/worker/src/m5.acceptance.test.ts:209` and `apps/worker/src/kubernetes/rollout.ts`.
Capture each health attempt's HTTP status and timing, plus Gateway route/backend
readiness throughout the bounded observation window. Determine why the intended
continuous failed-health response is classified as a timeout; repair the fixture or
observation path without relaxing the strict durable failure oracle. Then run
`pnpm test:acceptance:m5` twice against the real disposable DB/kind/Gateway setup.
Acceptance requires all 3/3 tests to pass both times, including durable nonretryable
`HEALTHCHECK_FAILED`, and cleanup to leave zero fixture rows and no managed namespaces.

## Prevention

Keep health classification assertions strict and make fixture prewarm prove that the
correct routed success endpoint is serving before starting the bounded health-failure
window. Retain per-attempt status/timing diagnostics so transient route readiness cannot
be confused with a stable application failure.
