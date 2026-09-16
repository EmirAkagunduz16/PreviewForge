---
id: RPT-2026-09-16-m5-health-acceptance-drift
type: incident
status: verified
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

## Resolution

The race was in `waitForHealthCheck`: a definitive failed HTTP response returned after
the rollout deadline was classified as `HEALTHCHECK_TIMEOUT`, which erased the stronger
nonretryable health failure. The rollout now preserves an observed failed response at the
deadline and only classifies a late successful response as `HEALTHCHECK_TIMEOUT`.

The strict `HEALTHCHECK_FAILED` oracle was retained. The focused rollout suite passed
16/16, then two consecutive real `pnpm test:acceptance:m5` runs passed all 3/3 tests
(81.41s and 80.60s). Cleanup after both runs reported zero fixture rows and zero managed
preview namespaces.

## Historical investigation and acceptance

The investigation inspected the health fixture and rollout path around
`apps/worker/src/m5.acceptance.test.ts:209` and `apps/worker/src/kubernetes/rollout.ts`.
Capture each health attempt's HTTP status and timing, plus Gateway route/backend
readiness throughout the bounded observation window. Determine why the intended
continuous failed-health response is classified as a timeout; repair the fixture or
observation path without relaxing the strict durable failure oracle. Then run
`pnpm test:acceptance:m5` twice against the real disposable DB/kind/Gateway setup.
The acceptance requirement was all 3/3 tests in both runs, including durable nonretryable
`HEALTHCHECK_FAILED`, and cleanup to leave zero fixture rows and no managed namespaces.

## Prevention

Keep health classification assertions strict: a definitive observed response must not be
replaced by a timeout merely because it crossed the observation deadline. Retain the
regression test at `apps/worker/src/kubernetes/rollout.test.ts`.
